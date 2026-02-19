// src/health/repair-patterns.ts
// Tier 1: Rule-Based Repair Patterns
//
// These are INSTANT fixes for known error patterns.
// No LLM call needed — pattern match the error, apply the fix.
// Saves time, money, and handles the most common failures.

import * as fs from 'fs';
import * as path from 'path';
import { RepairCategory } from './types';

// ============================================================
// PATTERN DEFINITION
// ============================================================

export interface RepairPattern {
  id: string;
  name: string;
  category: RepairCategory;
  
  // Match conditions (ALL must be true)
  match: {
    errorType?: RegExp;
    errorMessage?: RegExp;
    stackTrace?: RegExp;
    filePath?: RegExp;
  };
  
  // The fix — either a direct replacement or a function
  fix: RepairFix;
  
  // Safety
  requiresApproval: boolean;
  confidence: number;           // Pre-set confidence (0-1)
  maxApplicationsPerHour: number;
}

export type RepairFix =
  | { type: 'string_replace'; search: string | RegExp; replace: string; file?: string }
  | { type: 'env_update'; key: string; value: string }
  | { type: 'config_update'; filePath: string; jsonPath: string; value: any }
  | { type: 'file_replace'; filePath: string; search: RegExp; replace: string }
  | { type: 'function'; fn: (context: RepairContext) => Promise<RepairAction | null> };

export interface RepairContext {
  errorType: string;
  errorMessage: string;
  stackTrace?: string;
  filePath?: string;
  lineNumber?: number;
  projectRoot: string;
}

export interface RepairAction {
  filePath: string;
  originalCode: string;
  repairedCode: string;
  diagnosis: string;
}

// ============================================================
// APPLICATION TRACKER (rate limiting per pattern)
// ============================================================

const patternApplications: Map<string, number[]> = new Map();

function canApplyPattern(pattern: RepairPattern): boolean {
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const apps = (patternApplications.get(pattern.id) || []).filter(t => t > hourAgo);
  patternApplications.set(pattern.id, apps);
  return apps.length < pattern.maxApplicationsPerHour;
}

function recordApplication(pattern: RepairPattern): void {
  const apps = patternApplications.get(pattern.id) || [];
  apps.push(Date.now());
  patternApplications.set(pattern.id, apps);
}

// ============================================================
// PATTERN REGISTRY
// ============================================================

export const REPAIR_PATTERNS: RepairPattern[] = [

  // ──────────────────────────────────────────────────────
  // 1. SOLANA RPC ROTATION
  // Error: "failed to get recent blockhash" or ECONNREFUSED on RPC
  // Fix: Find the RPC URL in config and swap to backup
  // ──────────────────────────────────────────────────────
  {
    id: 'solana-rpc-rotate',
    name: 'Solana RPC Rotation',
    category: 'rpc_rotation',
    match: {
      errorMessage: /(?:failed to get recent blockhash|ECONNREFUSED|ETIMEDOUT|503|FetchError).*(?:solana|mainnet|helius|rpc)/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        const BACKUP_RPCS = [
          'https://api.mainnet-beta.solana.com',
          'https://rpc.helius.xyz/?api-key=',
          'https://mainnet.helius-rpc.com/?api-key=',
        ];

        // Find files that contain RPC URLs
        const configFiles = findFilesContaining(ctx.projectRoot, /(?:SOLANA_RPC|RPC_URL|rpcEndpoint|connection.*url)/i, ['.ts', '.js', '.env']);
        if (configFiles.length === 0) return null;

        for (const file of configFiles) {
          const content = fs.readFileSync(file, 'utf-8');
          
          // Find current RPC URL
          const rpcMatch = content.match(/(https?:\/\/[^\s'"`,]+(?:solana|helius|mainnet|rpc)[^\s'"`,]*)/i);
          if (!rpcMatch) continue;

          const currentRpc = rpcMatch[1];
          
          // Pick a backup that's different from current
          const backup = BACKUP_RPCS.find(r => !currentRpc.includes(r.split('?')[0].split('//')[1]));
          if (!backup) continue;

          return {
            filePath: file,
            originalCode: currentRpc,
            repairedCode: backup,
            diagnosis: `Solana RPC endpoint unreachable (${currentRpc.slice(0, 40)}...). Rotated to backup: ${backup.split('?')[0]}`,
          };
        }
        return null;
      },
    },
    requiresApproval: false,
    confidence: 0.9,
    maxApplicationsPerHour: 3,
  },

  // ──────────────────────────────────────────────────────
  // 2. TWITTER RATE LIMIT (429)
  // Fix: Find maxRepliesPerHour and reduce it
  // ──────────────────────────────────────────────────────
  {
    id: 'twitter-rate-limit',
    name: 'Twitter Rate Limit Adjustment',
    category: 'rate_limit_adjust',
    match: {
      errorMessage: /(?:429|rate limit|too many requests).*(?:twitter|x\.com|api\.twitter)/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        const configFiles = findFilesContaining(ctx.projectRoot, /maxRepliesPerHour|MAX_REPLIES_PER_HOUR|maxTotalRepliesPerHour/i, ['.ts', '.js']);
        if (configFiles.length === 0) return null;

        for (const file of configFiles) {
          const content = fs.readFileSync(file, 'utf-8');
          
          // Find the rate limit value
          const match = content.match(/((?:maxRepliesPerHour|MAX_REPLIES_PER_HOUR|maxTotalRepliesPerHour)\s*[:=]\s*)(\d+)/i);
          if (!match) continue;

          const currentValue = parseInt(match[2]);
          const newValue = Math.max(2, Math.floor(currentValue / 2)); // Halve it, minimum 2

          return {
            filePath: file,
            originalCode: match[0],
            repairedCode: `${match[1]}${newValue}`,
            diagnosis: `Twitter API rate limited (429). Reduced reply frequency from ${currentValue} to ${newValue} per hour. Will need manual restoration when rate limit clears.`,
          };
        }
        return null;
      },
    },
    requiresApproval: false,
    confidence: 0.95,
    maxApplicationsPerHour: 2,
  },

  // ──────────────────────────────────────────────────────
  // 3. OPENAI MODEL NOT FOUND
  // Fix: Swap deprecated model string to current one
  // ──────────────────────────────────────────────────────
  {
    id: 'openai-model-swap',
    name: 'OpenAI Model Fallback',
    category: 'model_fallback',
    match: {
      errorMessage: /(?:model.*not found|does not exist|deprecated|decommissioned).*(?:openai|gpt)/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        // Extract the bad model name from error
        const modelMatch = ctx.errorMessage.match(/(?:model|model_id)[:\s]*['"]*([a-z0-9\-_.]+)['"]/i);
        const badModel = modelMatch ? modelMatch[1] : null;

        // Known model migrations
        const MODEL_MIGRATIONS: Record<string, string> = {
          'gpt-4': 'gpt-4o',
          'gpt-4-0314': 'gpt-4o',
          'gpt-4-0613': 'gpt-4o',
          'gpt-4-32k': 'gpt-4o',
          'gpt-3.5-turbo-0301': 'gpt-4o-mini',
          'gpt-3.5-turbo-0613': 'gpt-4o-mini',
          'gpt-3.5-turbo': 'gpt-4o-mini',
          'gpt-4-turbo-preview': 'gpt-4o',
          'gpt-4-1106-preview': 'gpt-4o',
          'gpt-4o-2024-05-13': 'gpt-4o',
        };

        if (!badModel) return null;

        const replacement = MODEL_MIGRATIONS[badModel];
        if (!replacement) return null;

        // Find the file containing this model string
        const files = findFilesContaining(ctx.projectRoot, new RegExp(escapeRegex(badModel)), ['.ts', '.js', '.env', '.json']);
        if (files.length === 0) return null;

        const file = files[0];
        const content = fs.readFileSync(file, 'utf-8');

        return {
          filePath: file,
          originalCode: badModel,
          repairedCode: replacement,
          diagnosis: `OpenAI model '${badModel}' is deprecated/unavailable. Swapped to '${replacement}'.`,
        };
      },
    },
    requiresApproval: false,
    confidence: 0.9,
    maxApplicationsPerHour: 3,
  },

  // ──────────────────────────────────────────────────────
  // 4. TIMEOUT TOO SHORT
  // Fix: Find timeout value and increase it
  // ──────────────────────────────────────────────────────
  {
    id: 'timeout-increase',
    name: 'Timeout Increase',
    category: 'retry_logic',
    match: {
      errorMessage: /(?:ETIMEDOUT|timeout|timed out|AbortError|request.*timeout)/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        if (!ctx.filePath) return null;

        const fullPath = resolveFile(ctx.projectRoot, ctx.filePath);
        if (!fullPath) return null;

        const content = fs.readFileSync(fullPath, 'utf-8');

        // Find timeout values near the error line
        const lines = content.split('\n');
        const errorLine = ctx.lineNumber || 0;
        const searchStart = Math.max(0, errorLine - 20);
        const searchEnd = Math.min(lines.length, errorLine + 20);
        const region = lines.slice(searchStart, searchEnd).join('\n');

        // Match timeout patterns
        const timeoutMatch = region.match(/(timeout\s*[:=]\s*)(\d+)/i);
        if (!timeoutMatch) return null;

        const currentTimeout = parseInt(timeoutMatch[2]);
        // Double it, but cap at 60 seconds
        const newTimeout = Math.min(60_000, currentTimeout * 2);

        if (newTimeout === currentTimeout) return null;

        return {
          filePath: fullPath,
          originalCode: timeoutMatch[0],
          repairedCode: `${timeoutMatch[1]}${newTimeout}`,
          diagnosis: `Request timed out. Increased timeout from ${currentTimeout}ms to ${newTimeout}ms.`,
        };
      },
    },
    requiresApproval: false,
    confidence: 0.7,
    maxApplicationsPerHour: 5,
  },

  // ──────────────────────────────────────────────────────
  // 5. CANNOT FIND MODULE / IMPORT ERROR
  // Fix: Search for the module in node_modules, fix the import path
  // ──────────────────────────────────────────────────────
  {
    id: 'import-fix',
    name: 'Import Path Fix',
    category: 'import_fix',
    match: {
      errorMessage: /(?:Cannot find module|Module not found|ERR_MODULE_NOT_FOUND)/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        // Extract the broken module path
        const moduleMatch = ctx.errorMessage.match(/(?:Cannot find module|Module not found)[:\s]*['"]([^'"]+)['"]/i);
        if (!moduleMatch) return null;

        const brokenImport = moduleMatch[1];

        // Is this a relative import?
        if (brokenImport.startsWith('.') || brokenImport.startsWith('/')) {
          // Try common path variations
          const variations = [
            brokenImport.replace(/\.js$/, '.ts'),
            brokenImport.replace(/\.ts$/, '.js'),
            brokenImport + '/index',
            brokenImport.replace(/\/index$/, ''),
            brokenImport.replace('/dist/', '/src/'),
            brokenImport.replace('/src/', '/dist/'),
          ];

          if (!ctx.filePath) return null;
          const sourceDir = path.dirname(resolveFile(ctx.projectRoot, ctx.filePath) || '');

          for (const variant of variations) {
            const resolvedPath = path.resolve(sourceDir, variant);
            const extensions = ['', '.ts', '.js', '.mjs', '/index.ts', '/index.js'];
            
            for (const ext of extensions) {
              if (fs.existsSync(resolvedPath + ext)) {
                const fullPath = resolveFile(ctx.projectRoot, ctx.filePath)!;
                const content = fs.readFileSync(fullPath, 'utf-8');

                return {
                  filePath: fullPath,
                  originalCode: brokenImport,
                  repairedCode: variant,
                  diagnosis: `Import path '${brokenImport}' not found. Fixed to '${variant}' (file exists at ${resolvedPath + ext}).`,
                };
              }
            }
          }
        } else {
          // npm package — check if it exists in node_modules
          const nmPath = path.join(ctx.projectRoot, 'node_modules', brokenImport);
          if (!fs.existsSync(nmPath)) {
            // Package not installed — can't fix automatically, but can diagnose
            return {
              filePath: ctx.filePath || 'unknown',
              originalCode: '',
              repairedCode: '',
              diagnosis: `Package '${brokenImport}' is not installed. Run: npm install ${brokenImport}`,
            };
          }
        }

        return null;
      },
    },
    requiresApproval: false,
    confidence: 0.8,
    maxApplicationsPerHour: 10,
  },

  // ──────────────────────────────────────────────────────
  // 6. DATABASE COLUMN NOT FOUND
  // Fix: Check if column name changed (common in ElizaOS updates)
  // ──────────────────────────────────────────────────────
  {
    id: 'db-column-fix',
    name: 'Database Column Fix',
    category: 'query_fix',
    match: {
      errorMessage: /(?:column.*does not exist|undefined column|unknown column|no such column)/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        // Extract the bad column name
        const colMatch = ctx.errorMessage.match(/column\s+['"]*(\w+)['"]/i);
        if (!colMatch) return null;

        const badColumn = colMatch[1];

        // Common ElizaOS column renames / snake_case ↔ camelCase
        const COLUMN_MIGRATIONS: Record<string, string> = {
          'userId': 'user_id',
          'user_id': 'userId',
          'roomId': 'room_id',
          'room_id': 'roomId',
          'agentId': 'agent_id',
          'agent_id': 'agentId',
          'createdAt': 'created_at',
          'created_at': 'createdAt',
          'updatedAt': 'updated_at',
          'updated_at': 'updatedAt',
        };

        const replacement = COLUMN_MIGRATIONS[badColumn];
        if (!replacement) return null;

        // Find the query containing this column
        if (!ctx.filePath) return null;
        const fullPath = resolveFile(ctx.projectRoot, ctx.filePath);
        if (!fullPath) return null;

        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.includes(badColumn)) return null;

        return {
          filePath: fullPath,
          originalCode: badColumn,
          repairedCode: replacement,
          diagnosis: `Database column '${badColumn}' doesn't exist. Likely renamed to '${replacement}' (snake_case ↔ camelCase migration).`,
        };
      },
    },
    requiresApproval: false,
    confidence: 0.75,
    maxApplicationsPerHour: 5,
  },

  // ──────────────────────────────────────────────────────
  // 7. PROPERTY UNDEFINED — common .data, .result, .response changes
  // Fix: Add optional chaining or adjust property access
  // ──────────────────────────────────────────────────────
  {
    id: 'property-access-fix',
    name: 'Property Access Fix',
    category: 'type_fix',
    match: {
      errorMessage: /(?:Cannot read propert(?:y|ies) of (?:undefined|null)|TypeError.*undefined.*(?:reading|property))/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        if (!ctx.filePath || !ctx.lineNumber) return null;

        const fullPath = resolveFile(ctx.projectRoot, ctx.filePath);
        if (!fullPath) return null;

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        
        if (ctx.lineNumber > lines.length) return null;
        const errorLine = lines[ctx.lineNumber - 1];

        // Extract the property being accessed
        const propMatch = ctx.errorMessage.match(/reading\s+['"](\w+)['"]/i);
        const prop = propMatch ? propMatch[1] : null;

        // Find chained property access that should have optional chaining
        // e.g., response.data.results → response?.data?.results
        const chainMatch = errorLine.match(/(\w+(?:\.\w+)+)/g);
        if (!chainMatch) return null;

        // Find the chain that contains the problematic property
        let targetChain = chainMatch.find(c => prop ? c.includes(`.${prop}`) : true);
        if (!targetChain) targetChain = chainMatch[0];

        // Add optional chaining
        const parts = targetChain.split('.');
        const safeChain = parts.join('?.');

        return {
          filePath: fullPath,
          originalCode: targetChain,
          repairedCode: safeChain,
          diagnosis: `Property access on undefined/null object. Added optional chaining: '${targetChain}' → '${safeChain}'.`,
        };
      },
    },
    requiresApproval: false,
    confidence: 0.65,
    maxApplicationsPerHour: 10,
  },

  // ──────────────────────────────────────────────────────
  // 8. JSON PARSE ERROR — API response format changed
  // Fix: Add try-catch wrapper around JSON.parse
  // ──────────────────────────────────────────────────────
  {
    id: 'json-parse-guard',
    name: 'JSON Parse Safety Guard',
    category: 'type_fix',
    match: {
      errorMessage: /(?:SyntaxError.*JSON|Unexpected token.*JSON|JSON\.parse)/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        if (!ctx.filePath || !ctx.lineNumber) return null;

        const fullPath = resolveFile(ctx.projectRoot, ctx.filePath);
        if (!fullPath) return null;

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        
        if (ctx.lineNumber > lines.length) return null;
        const errorLine = lines[ctx.lineNumber - 1].trim();

        // Find JSON.parse call
        const parseMatch = errorLine.match(/JSON\.parse\(([^)]+)\)/);
        if (!parseMatch) return null;

        const parseArg = parseMatch[1];
        const indent = lines[ctx.lineNumber - 1].match(/^(\s*)/)?.[1] || '';

        // Wrap in try-catch with fallback
        const original = errorLine;
        const variableMatch = errorLine.match(/(?:const|let|var)\s+(\w+)\s*=\s*JSON\.parse/);
        
        if (variableMatch) {
          const varName = variableMatch[1];
          const repaired = [
            `let ${varName};`,
            `${indent}try {`,
            `${indent}  ${varName} = JSON.parse(${parseArg});`,
            `${indent}} catch (parseErr) {`,
            `${indent}  console.error('[HealthFix] JSON parse failed, using fallback:', parseErr.message);`,
            `${indent}  ${varName} = typeof ${parseArg} === 'object' ? ${parseArg} : {};`,
            `${indent}}`,
          ].join('\n');

          return {
            filePath: fullPath,
            originalCode: original,
            repairedCode: repaired,
            diagnosis: `JSON.parse failed on unexpected response format. Added try-catch with fallback to handle non-JSON responses.`,
          };
        }

        return null;
      },
    },
    requiresApproval: true, // Modifying logic flow — needs approval
    confidence: 0.7,
    maxApplicationsPerHour: 5,
  },

  // ──────────────────────────────────────────────────────
  // 9. PORT ALREADY IN USE
  // Fix: Find the port config and increment it
  // ──────────────────────────────────────────────────────
  {
    id: 'port-conflict',
    name: 'Port Conflict Resolution',
    category: 'config_fix',
    match: {
      errorMessage: /(?:EADDRINUSE|address already in use|port.*(?:in use|unavailable))/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        const portMatch = ctx.errorMessage.match(/(?:port\s*|:)(\d{4,5})/i);
        if (!portMatch) return null;

        const currentPort = parseInt(portMatch[1]);
        const newPort = currentPort + 1;

        // Find files containing this port
        const files = findFilesContaining(ctx.projectRoot, new RegExp(`(?:PORT|port)\\s*[:=]\\s*${currentPort}`), ['.ts', '.js', '.env']);
        if (files.length === 0) return null;

        const file = files[0];
        const content = fs.readFileSync(file, 'utf-8');

        return {
          filePath: file,
          originalCode: String(currentPort),
          repairedCode: String(newPort),
          diagnosis: `Port ${currentPort} already in use. Changed to ${newPort}.`,
        };
      },
    },
    requiresApproval: false,
    confidence: 0.85,
    maxApplicationsPerHour: 3,
  },

  // ──────────────────────────────────────────────────────
  // 10. FETCH/AXIOS URL 404 — API endpoint moved
  // Fix: Try common URL variations
  // ──────────────────────────────────────────────────────
  {
    id: 'api-endpoint-404',
    name: 'API Endpoint 404 Fix',
    category: 'api_endpoint',
    match: {
      errorMessage: /(?:404|Not Found).*(?:https?:\/\/)/i,
    },
    fix: {
      type: 'function',
      fn: async (ctx: RepairContext): Promise<RepairAction | null> => {
        // Extract the failing URL
        const urlMatch = ctx.errorMessage.match(/(https?:\/\/[^\s'"]+)/);
        if (!urlMatch) return null;

        const badUrl = urlMatch[1];

        // Try common URL migrations
        const variations = [
          badUrl.replace('/v1/', '/v2/'),
          badUrl.replace('/v2/', '/v3/'),
          badUrl.replace('/api/', '/api/v1/'),
          badUrl.replace('http://', 'https://'),
        ];

        // Test each variation
        for (const url of variations) {
          try {
            const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
            if (response.ok || response.status === 401) {
              // Found a working URL
              if (!ctx.filePath) return null;
              const fullPath = resolveFile(ctx.projectRoot, ctx.filePath);
              if (!fullPath) return null;

              return {
                filePath: fullPath,
                originalCode: badUrl,
                repairedCode: url,
                diagnosis: `API endpoint returned 404 at '${badUrl}'. Found working endpoint at '${url}'.`,
              };
            }
          } catch {
            continue;
          }
        }

        return null;
      },
    },
    requiresApproval: false,
    confidence: 0.85,
    maxApplicationsPerHour: 5,
  },
];

// ============================================================
// PATTERN MATCHER — finds the best pattern for an error
// ============================================================

export function findMatchingPattern(
  errorType: string,
  errorMessage: string,
  stackTrace?: string,
  filePath?: string
): RepairPattern | null {
  for (const pattern of REPAIR_PATTERNS) {
    if (!canApplyPattern(pattern)) continue;

    const match = pattern.match;
    let allMatch = true;

    if (match.errorType && !match.errorType.test(errorType)) allMatch = false;
    if (match.errorMessage && !match.errorMessage.test(errorMessage)) allMatch = false;
    if (match.stackTrace && stackTrace && !match.stackTrace.test(stackTrace)) allMatch = false;
    if (match.filePath && filePath && !match.filePath.test(filePath)) allMatch = false;

    if (allMatch) {
      return pattern;
    }
  }

  return null;
}

export async function executePattern(
  pattern: RepairPattern,
  context: RepairContext
): Promise<RepairAction | null> {
  try {
    const fix = pattern.fix;

    if (fix.type === 'function') {
      const result = await fix.fn(context);
      if (result) {
        recordApplication(pattern);
      }
      return result;
    }

    if (fix.type === 'file_replace') {
      const fullPath = resolveFile(context.projectRoot, fix.filePath);
      if (!fullPath || !fs.existsSync(fullPath)) return null;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const match = content.match(fix.search);
      if (!match) return null;

      recordApplication(pattern);
      return {
        filePath: fullPath,
        originalCode: match[0],
        repairedCode: content.replace(fix.search, fix.replace).slice(
          content.indexOf(match[0]),
          content.indexOf(match[0]) + fix.replace.length + 100
        ),
        diagnosis: `Pattern '${pattern.name}' matched. Applied regex replacement.`,
      };
    }

    return null;
  } catch (err: any) {
    console.error(`[RepairPatterns] Pattern '${pattern.id}' execution failed:`, err.message);
    return null;
  }
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function findFilesContaining(root: string, pattern: RegExp, extensions: string[], maxDepth: number = 4): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    if (!fs.existsSync(dir)) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        // Skip noise
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;

        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
          if (seen.has(fullPath)) continue;
          seen.add(fullPath);

          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (pattern.test(content)) {
              results.push(fullPath);
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  walk(root, 0);
  return results;
}

function resolveFile(projectRoot: string, filePath: string): string | null {
  if (fs.existsSync(filePath)) return filePath;
  
  const fromRoot = path.join(projectRoot, filePath);
  if (fs.existsSync(fromRoot)) return fromRoot;

  // Try stripping container paths
  const stripped = filePath.replace(/^\/app\//, '').replace(/^\/home\/\w+\//, '');
  const fromRootStripped = path.join(projectRoot, stripped);
  if (fs.existsSync(fromRootStripped)) return fromRootStripped;

  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

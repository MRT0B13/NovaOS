const fs = require('fs');
const path = require('path');

// ============================================================================
// Patch 1: Telegraf readonly error message fix
// ============================================================================
function patchTelegraf() {
    const file = path.join(__dirname, '../node_modules/telegraf/lib/core/network/client.js');
    
    if (!fs.existsSync(file)) {
        console.log('[Telegraf] Skipped - not installed');
        return;
    }
    
    let content = fs.readFileSync(file, 'utf8');

    const oldCode = `function redactToken(error) {
    error.message = error.message.replace(/\\/(bot|user)(\\d+):[^/]+\\//, '/$1$2:[REDACTED]/');
    throw error;
}`;

    const newCode = `function redactToken(error) {
    try {
        error.message = error.message.replace(/\\/(bot|user)(\\d+):[^/]+\\//, '/$1$2:[REDACTED]/');
    } catch {
        // Some error objects have readonly message property
    }
    throw error;
}`;

    if (content.includes('try {')) {
        console.log('[Telegraf] Already patched');
    } else {
        content = content.replace(oldCode, newCode);
        fs.writeFileSync(file, content);
        console.log('[Telegraf] Patched successfully');
    }
}

// ============================================================================
// Patch 2: @elizaos/plugin-sql Unicode surrogate pair fix
// ============================================================================
function patchPluginSql() {
    const file = path.join(__dirname, '../node_modules/@elizaos/plugin-sql/dist/node/index.node.js');
    
    if (!fs.existsSync(file)) {
        console.log('[plugin-sql] Skipped - not installed');
        return;
    }
    
    let content = fs.readFileSync(file, 'utf8');

    // Check if already patched (look for our fixBrokenSurrogates function)
    if (content.includes('fixBrokenSurrogates')) {
        console.log('[plugin-sql] Already patched');
        return;
    }

    // The new fixBrokenSurrogates method to add before sanitizeJsonObject
    const fixBrokenSurrogatesMethod = `
  // Fix broken Unicode surrogate pairs that cause PostgreSQL JSON parsing errors
  // This handles cases like \\uD83D without its matching low surrogate
  fixBrokenSurrogates(str) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      // Check if this is a high surrogate (\\uD800-\\uDBFF)
      if (code >= 0xD800 && code <= 0xDBFF) {
        const nextCode = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        // Check if next char is a valid low surrogate (\\uDC00-\\uDFFF)
        if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
          // Valid pair, keep both
          result += str[i] + str[i + 1];
          i++; // Skip the low surrogate
        }
        // else: orphan high surrogate, skip it
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        // Orphan low surrogate, skip it
      } else {
        result += str[i];
      }
    }
    return result;
  }
`;

    // Find sanitizeJsonObject and add our method before it
    const sanitizeStart = content.indexOf('sanitizeJsonObject(value, seen = new WeakSet)');
    if (sanitizeStart === -1) {
        console.log('[plugin-sql] Could not find sanitizeJsonObject - skipping');
        return;
    }

    // Find the start of the method (the "  " indentation before it)
    let insertPos = sanitizeStart;
    while (insertPos > 0 && content[insertPos - 1] !== '\n') {
        insertPos--;
    }

    // Insert our new method before sanitizeJsonObject
    content = content.slice(0, insertPos) + fixBrokenSurrogatesMethod + content.slice(insertPos);

    // Now patch the sanitizeJsonObject string handling to use our fix
    // Find and replace the string sanitization line
    const oldStringSanitize = 'return value.replace(/\\u0000/g, "").replace(/\\\\(?!["\\\\/bfnrtu])/g, "\\\\\\\\").replace(/\\\\u(?![0-9a-fA-F]{4})/g, "\\\\\\\\u");';
    const newStringSanitize = 'const fixed = this.fixBrokenSurrogates(value); return fixed.replace(/\\u0000/g, "").replace(/\\\\(?!["\\\\/bfnrtu])/g, "\\\\\\\\").replace(/\\\\u(?![0-9a-fA-F]{4})/g, "\\\\\\\\u");';

    if (content.includes(oldStringSanitize)) {
        content = content.replace(oldStringSanitize, newStringSanitize);
    } else {
        // Try a more flexible match - look for the pattern in the file
        const strSanitizePattern = /return value\.replace\(\/\\u0000\/g, ""\)\.replace\([^)]+\)\.replace\([^)]+\);/;
        content = content.replace(strSanitizePattern, (match) => {
            return 'const fixed = this.fixBrokenSurrogates(value); return fixed' + match.slice('return value'.length);
        });
    }

    // Also patch the key sanitization
    const oldKeySanitize = 'const sanitizedKey = typeof key === "string" ? key.replace(/\\u0000/g, "")';
    const newKeySanitize = 'const sanitizedKey = typeof key === "string" ? this.fixBrokenSurrogates(key).replace(/\\u0000/g, "")';
    
    content = content.replace(oldKeySanitize, newKeySanitize);

    fs.writeFileSync(file, content);
    console.log('[plugin-sql] Patched successfully - fixed Unicode surrogate pair handling');
}

// Run all patches
patchTelegraf();
patchPluginSql();

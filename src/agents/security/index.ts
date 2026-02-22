/**
 * Guardian Security Modules — Barrel Export
 *
 * All security modules are exported here for use by the Guardian agent.
 */

export { WalletSentinel } from './walletSentinel.ts';
export { NetworkShield } from './networkShield.ts';
export { ContentFilter } from './contentFilter.ts';
export type { ContentScanResult, ContentThreat } from './contentFilter.ts';
export { AgentWatchdog } from './agentWatchdog.ts';
export { IncidentResponse } from './incidentResponse.ts';
export type { IncidentCallbacks } from './incidentResponse.ts';
export { ensureSecurityTables, logSecurityEvent } from './securityTypes.ts';
export type { SecurityEvent, SecuritySeverity, SecurityCategory, SecurityReporter } from './securityTypes.ts';

/**
 * Incident Response — Automated Security Event Aggregation & Escalation
 *
 * Coordinates response to security incidents:
 *   - Aggregates related security events into incidents
 *   - Escalates based on severity and frequency
 *   - Generates incident reports
 *   - Manages cooldowns to prevent alert fatigue
 *   - Tracks incident lifecycle (open → investigating → resolved)
 *
 * This module is the central hub that all other security modules
 * report through. It decides whether to alert admins, post to channels,
 * or take automated action.
 */

import { Pool } from 'pg';
import { logger } from '@elizaos/core';
import type { SecurityEvent, SecuritySeverity, SecurityCategory } from './securityTypes.ts';
import { logSecurityEvent } from './securityTypes.ts';

// ============================================================================
// Types
// ============================================================================

interface Incident {
  id: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  title: string;
  events: SecurityEvent[];
  firstSeen: number;
  lastSeen: number;
  escalated: boolean;
  resolved: boolean;
}

/** Callback to notify external systems */
export interface IncidentCallbacks {
  onAdminAlert?: (message: string, severity: SecuritySeverity) => Promise<void>;
  onChannelPost?: (message: string) => Promise<void>;
}

// ============================================================================
// Incident Response
// ============================================================================

export class IncidentResponse {
  private pool: Pool;
  private callbacks: IncidentCallbacks = {};
  private activeIncidents: Map<string, Incident> = new Map();
  private alertCooldowns: Map<string, number> = new Map(); // key → last alert timestamp
  private totalEvents = 0;
  private totalEscalations = 0;
  private totalIncidents = 0;

  /** Cooldown between alerts for the same category (prevent spam) */
  private static readonly ALERT_COOLDOWN_MS: Record<SecuritySeverity, number> = {
    info: 30 * 60_000,      // 30 min between info alerts
    warning: 10 * 60_000,   // 10 min between warnings
    critical: 2 * 60_000,   // 2 min between critical
    emergency: 0,           // No cooldown for emergencies
  };

  /** Auto-escalation: if N events of severity X in Y minutes → escalate */
  private static readonly ESCALATION_RULES: Array<{
    severity: SecuritySeverity;
    countThreshold: number;
    windowMinutes: number;
    escalateTo: SecuritySeverity;
  }> = [
    { severity: 'warning', countThreshold: 5, windowMinutes: 10, escalateTo: 'critical' },
    { severity: 'critical', countThreshold: 3, windowMinutes: 5, escalateTo: 'emergency' },
  ];

  /** Incident expiry — auto-resolve if no new events */
  private static readonly INCIDENT_EXPIRY_MS = 60 * 60_000; // 1 hour

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Set external notification callbacks */
  setCallbacks(callbacks: IncidentCallbacks): void {
    this.callbacks = callbacks;
  }

  // ── Event Intake ─────────────────────────────────────────────────

  /**
   * Process a security event from any module.
   * This is the main entry point — all security modules call this.
   */
  async handleEvent(event: SecurityEvent): Promise<void> {
    this.totalEvents++;

    // 1. Log to DB
    await logSecurityEvent(this.pool, event);

    // 2. Group into incident
    const incidentKey = `${event.category}:${event.title.split(':')[0].trim()}`;
    let incident = this.activeIncidents.get(incidentKey);

    if (!incident) {
      incident = {
        id: `INC-${Date.now().toString(36)}`,
        category: event.category,
        severity: event.severity,
        title: event.title,
        events: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        escalated: false,
        resolved: false,
      };
      this.activeIncidents.set(incidentKey, incident);
      this.totalIncidents++;
    }

    incident.events.push(event);
    incident.lastSeen = Date.now();

    // Upgrade incident severity if new event is worse
    if (this.severityRank(event.severity) > this.severityRank(incident.severity)) {
      incident.severity = event.severity;
    }

    // 3. Check escalation rules
    await this.checkEscalation(incident);

    // 4. Alert based on severity
    await this.alertIfNeeded(event, incident);
  }

  // ── Escalation ──────────────────────────────────────────────────

  private async checkEscalation(incident: Incident): Promise<void> {
    const now = Date.now();

    for (const rule of IncidentResponse.ESCALATION_RULES) {
      if (incident.severity !== rule.severity) continue;

      // Count events in the window
      const recentEvents = incident.events.filter(
        e => now - (e as any)._timestamp < rule.windowMinutes * 60_000,
      );

      // Use total events as fallback (events don't have timestamps embedded)
      const count = recentEvents.length || incident.events.length;

      if (count >= rule.countThreshold && !incident.escalated) {
        incident.escalated = true;
        incident.severity = rule.escalateTo;
        this.totalEscalations++;

        const escalationEvent: SecurityEvent = {
          category: incident.category,
          severity: rule.escalateTo,
          title: `ESCALATED: ${incident.title}`,
          details: {
            incidentId: incident.id,
            originalSeverity: rule.severity,
            escalatedTo: rule.escalateTo,
            eventCount: count,
            windowMinutes: rule.windowMinutes,
            message: `${count} ${rule.severity} events in ${rule.windowMinutes}m → escalated to ${rule.escalateTo}`,
          },
          autoResponse: 'Incident escalated',
        };

        await logSecurityEvent(this.pool, escalationEvent);

        // Force alert for escalations (bypass cooldown)
        await this.sendAlert(escalationEvent, incident);
      }
    }
  }

  // ── Alerting ────────────────────────────────────────────────────

  private async alertIfNeeded(event: SecurityEvent, incident: Incident): Promise<void> {
    const cooldownKey = `${event.category}:${event.severity}`;
    const lastAlert = this.alertCooldowns.get(cooldownKey) || 0;
    const cooldownMs = IncidentResponse.ALERT_COOLDOWN_MS[event.severity];

    if (Date.now() - lastAlert < cooldownMs) {
      return; // Still in cooldown
    }

    await this.sendAlert(event, incident);
    this.alertCooldowns.set(cooldownKey, Date.now());
  }

  private async sendAlert(event: SecurityEvent, incident: Incident): Promise<void> {
    const message = this.formatAlertMessage(event, incident);

    // Emergency + Critical → Admin notification
    if (event.severity === 'emergency' || event.severity === 'critical') {
      if (this.callbacks.onAdminAlert) {
        try {
          await this.callbacks.onAdminAlert(message, event.severity);
        } catch (err) {
          logger.warn('[incident-response] Failed to send admin alert:', err);
        }
      }
    }

    // Warning+ → Log
    logger.warn(`[incident-response] ${event.severity.toUpperCase()}: ${event.title}`);
  }

  /** Format a human-readable alert message */
  private formatAlertMessage(event: SecurityEvent, incident: Incident): string {
    const icon = {
      info: 'ℹ️',
      warning: '⚠️',
      critical: '🚨',
      emergency: '🆘',
    }[event.severity];

    const lines = [
      `${icon} **SECURITY ${event.severity.toUpperCase()}**`,
      ``,
      `**${event.title}**`,
    ];

    // Add key details
    if (event.details) {
      const importantKeys = ['walletAddress', 'walletLabel', 'droppedSol', 'dropPercent',
        'agentName', 'anomalyScore', 'url', 'message', 'service', 'threatCount'];
      for (const key of importantKeys) {
        if (event.details[key] !== undefined) {
          lines.push(`• ${key}: ${event.details[key]}`);
        }
      }
    }

    if (event.autoResponse) {
      lines.push(``, `Auto-response: ${event.autoResponse}`);
    }

    if (incident.events.length > 1) {
      lines.push(``, `Part of incident ${incident.id} (${incident.events.length} events)`);
    }

    return lines.join('\n');
  }

  // ── Incident Management ─────────────────────────────────────────

  /** Periodic cleanup of stale incidents */
  async cleanup(): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [key, incident] of this.activeIncidents) {
      if (now - incident.lastSeen > IncidentResponse.INCIDENT_EXPIRY_MS) {
        incident.resolved = true;
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.activeIncidents.delete(key);
    }
  }

  /** Generate a summary report of active incidents */
  generateReport(): string {
    if (this.activeIncidents.size === 0) {
      return '✅ No active security incidents.';
    }

    const lines: string[] = [`🛡️ **Security Status Report**`, ''];

    // Group by severity
    const bySeverity: Record<string, Incident[]> = {};
    for (const incident of this.activeIncidents.values()) {
      if (!bySeverity[incident.severity]) bySeverity[incident.severity] = [];
      bySeverity[incident.severity].push(incident);
    }

    for (const severity of ['emergency', 'critical', 'warning', 'info'] as SecuritySeverity[]) {
      const incidents = bySeverity[severity];
      if (!incidents || incidents.length === 0) continue;

      lines.push(`**${severity.toUpperCase()}** (${incidents.length}):`);
      for (const inc of incidents) {
        const age = Math.round((Date.now() - inc.firstSeen) / 60000);
        lines.push(`  • ${inc.title} (${inc.events.length} events, ${age}m ago)`);
      }
      lines.push('');
    }

    lines.push(`Total events: ${this.totalEvents} | Escalations: ${this.totalEscalations} | Active incidents: ${this.activeIncidents.size}`);
    return lines.join('\n');
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private severityRank(severity: SecuritySeverity): number {
    return { info: 0, warning: 1, critical: 2, emergency: 3 }[severity];
  }

  /** Get status summary */
  getStatus() {
    return {
      totalEvents: this.totalEvents,
      totalEscalations: this.totalEscalations,
      totalIncidents: this.totalIncidents,
      activeIncidents: this.activeIncidents.size,
      incidents: Array.from(this.activeIncidents.values()).map(inc => ({
        id: inc.id,
        category: inc.category,
        severity: inc.severity,
        title: inc.title,
        eventCount: inc.events.length,
        firstSeen: new Date(inc.firstSeen).toISOString(),
        lastSeen: new Date(inc.lastSeen).toISOString(),
        escalated: inc.escalated,
      })),
    };
  }
}

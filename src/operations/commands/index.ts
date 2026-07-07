/**
 * Commands module - User command handling
 *
 * Exports all user command handlers for session management,
 * collaboration, permissions, and utility commands.
 */

export {
  // Session control
  cancelSession,
  interruptSession,
  approvePendingPlan,
  queueMessage,
  steerSession,
  importContext,

  // Directory management
  changeDirectory,
  generateWorkSummary,

  // User collaboration
  inviteUser,
  kickUser,
  setGitHubEmail,

  // Permission management
  setSessionPermissionMode,

  // Model selection (`!model`)
  showModelPicker,
  applyModelPick,

  // Message approval
  requestMessageApproval,

  // Session header
  updateSessionHeader,

  // Update commands
  showUpdateStatus,
  forceUpdateNow,
  deferUpdate,

  // Bug reporting
  reportBug,
  handleBugReportApproval,

  // Archive search (`!search`)
  searchArchiveCommand,

  // Restart helper (used by plugin handler)
  restartClaudeSession,
} from './handler.js';

export type { AutoUpdateManagerInterface } from './handler.js';

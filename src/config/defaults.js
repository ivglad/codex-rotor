import { defaultSlotHome } from './paths.js';

export function defaultConfig() {
  return {
    schema_version: 2,
    default_slot: 'main',
    slots: [
      {
        id: 'main',
        label: 'Main',
        codex_home: defaultSlotHome('main'),
        priority: 100,
        enabled: true
      }
    ],
    rotation: {
      max_retries: 1,
      quick_fail_seconds: 50,
      limit_block_seconds: 5 * 60 * 60,
      auth_block_seconds: 15 * 60
    },
    scheduling: {
      mode: 'terminal_pinned'
    },
    notifications: {
      telegram_enabled: false,
      bot_token_env: 'CODEX_ROTOR_TELEGRAM_BOT_TOKEN',
      chat_id_env: 'CODEX_ROTOR_TELEGRAM_CHAT_ID'
    }
  };
}

export function defaultState() {
  return {
    schema_version: 2,
    active_slot: 'main',
    last_rotation_at: null,
    last_rotation_reason: null,
    sessions: {},
    leases: {},
    slots: {
      main: {
        status: 'ready',
        blocked_until: null,
        last_error: null,
        last_error_at: null,
        last_ok: null
      }
    }
  };
}

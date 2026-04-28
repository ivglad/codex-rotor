import crypto from 'node:crypto';

const SOURCE_KEYS = [
  'TMUX_PANE',
  'WEZTERM_PANE',
  'WT_SESSION',
  'KITTY_WINDOW_ID',
  'ALACRITTY_WINDOW_ID'
];

function hashSeed(seed) {
  return crypto.createHash('sha1').update(String(seed), 'utf8').digest('hex').slice(0, 12);
}

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function resolveTerminalId(env = process.env) {
  const explicit = clean(env.CODEX_ROTOR_TERMINAL_ID);
  if (explicit) return explicit;

  for (const key of SOURCE_KEYS) {
    const value = clean(env[key]);
    if (value) return `${key}:${value}`;
  }

  const fallbackSeed = [
    clean(env.TERM),
    clean(env.COLORTERM),
    clean(env.SHELL),
    clean(env.PWD),
    String(process.ppid),
    String(process.getuid?.() ?? '')
  ].join('|');

  return `fallback:${hashSeed(fallbackSeed)}`;
}

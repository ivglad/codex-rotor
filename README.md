# codex-rotor

Прозрачный ротор аккаунтов для Codex CLI (OAuth-only, без API-ключей).
Рабочий флоу остается стандартным: используешь `codex`, ротация происходит после явной `limit/auth` ошибки.

## Требования

- Node.js `>=22`
- npm
- установленный upstream Codex CLI (`@openai/codex`)

## Установка

```bash
npm install -g @openai/codex
npm install -g --force git+https://github.com/ivglad/codex-rotor.git
```

`codex-rotor` не поставляет и не вендорит `codex` внутри себя: upstream Codex CLI должен быть установлен отдельно.
Флаг `--force` нужен, потому что `codex-rotor` целенаправленно перехватывает команду `codex` (wrapper) поверх установленного upstream Codex.

## Первый запуск

```bash
codex-rotor init
codex-rotor add
codex-rotor add
codex
```

После limit/auth ошибки:
1. `codex-rotor` переключает слот;
2. ты вручную перезапускаешь `codex`;
3. продолжаешь работу из истории.

Перед запуском `codex` wrapper также делает preflight-проверку лимитов:
- через `codex app-server` (`account/rateLimits/read`);
- и дополнительно по локальным session snapshots (с учетом `auth.json:last_refresh`, чтобы игнорировать старые данные от прошлого логина).

## Основные команды

```bash
codex-rotor add [--no-login]
codex-rotor status
codex-rotor watch [--interval SEC]   # по умолчанию 5 секунд
codex-rotor login-all
codex-rotor rotate
codex-rotor unblock <slot-id>
```

## Multi-terminal поведение

- По умолчанию режим планировщика: `terminal_pinned`.
- Каждый терминал получает `terminal_id` (из `CODEX_ROTOR_TERMINAL_ID` или авто-детект из `TMUX_PANE/WEZTERM_PANE/...`).
- Во время активной сессии слот берется в runtime-lease, чтобы параллельные запуски из других терминалов не заняли тот же слот.

## Переменные окружения (опционально)

### App Server preflight limits

- `CODEX_ROTOR_APP_SERVER_LIMITS` — включить/выключить app-server probe (`true` по умолчанию).
- `CODEX_ROTOR_APP_SERVER_TIMEOUT_MS` — таймаут probe (по умолчанию `4000`).
- `CODEX_ROTOR_APP_SERVER_RETRIES` — retry count для перегрузки app-server `-32001` (по умолчанию `2`).
- `CODEX_ROTOR_APP_SERVER_RETRY_BASE_DELAY_MS` — базовая задержка backoff (по умолчанию `120`).
- `CODEX_ROTOR_APP_SERVER_LIMIT_ID` — какой bucket смотреть в `rateLimitsByLimitId` (по умолчанию `codex`).

### Terminal identity

- `CODEX_ROTOR_TERMINAL_ID` — явный стабильный ID терминала (если хочешь зафиксировать вручную).

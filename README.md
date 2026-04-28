# codex-rotor

Прозрачный ротор аккаунтов для Codex CLI (OAuth-only, без API-ключей).
Рабочий флоу остается стандартным: используешь `codex`, ротация происходит после явной `limit/auth` ошибки.

## Требования

- Node.js `>=22`
- npm
- установленный upstream Codex CLI (`@openai/codex`)

## Установка

```bash
npm install -g git+https://github.com/ivglad/codex-rotor.git
```

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

## Основные команды

```bash
codex-rotor add [--no-login]
codex-rotor status
codex-rotor watch [--interval SEC]   # по умолчанию 5 секунд
codex-rotor login-all
codex-rotor rotate
codex-rotor unblock <slot-id>
```

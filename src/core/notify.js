function getNotificationConfig(config) {
  return config?.notifications || {};
}

export async function notifyTelegram(config, message) {
  const ncfg = getNotificationConfig(config);
  if (!ncfg.telegram_enabled) {
    return false;
  }

  const tokenEnv = String(ncfg.bot_token_env || 'CODEX_ROTOR_TELEGRAM_BOT_TOKEN');
  const chatEnv = String(ncfg.chat_id_env || 'CODEX_ROTOR_TELEGRAM_CHAT_ID');
  const token = process.env[tokenEnv] || null;
  const chatId = process.env[chatEnv] || null;
  if (!token || !chatId) {
    return false;
  }

  try {
    const body = new URLSearchParams({
      chat_id: chatId,
      text: message
    });
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      body
    });
    return resp.ok;
  } catch {
    return false;
  }
}

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      TELEGRAM_BOT_TOKEN: string;
      NOTION_API_KEY: string;
      DATABASE_ID: string;
    }
  }
}

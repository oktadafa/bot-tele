import { Bot } from "grammy";

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
// 1. Log Global untuk memantau apakah ada data masuk dari Telegram
bot.use(async (ctx, next) => {
  console.log(`[LOG] Ada update masuk jenis: ${ctx.updateType}`);
  await next();
});

// 2. Handler khusus untuk pesan teks
bot.on("message:text", async (ctx) => {
  console.log(`[Pesan Teks] Dari ${ctx.from?.first_name}: ${ctx.message.text}`);

  try {
    await ctx.reply("test");
    console.log(
      `[Sukses] Berhasil mengirim balasan ke ${ctx.from?.first_name}`
    );
  } catch (error) {
    console.error("[Error] Gagal mengirim balasan:", error);
  }
});

// ==========================================
// FUNGSI UTAMA UNTUK MENYALAKAN BOT
// ==========================================
async function main() {
  console.log("Sedang membersihkan koneksi webhook lama...");
  // Jangan di-comment baris ini, ini penting agar polling-nya tidak nyangkut!
  await bot.api.deleteWebhook({ drop_pending_updates: true });

  console.log("Bot berhasil berjalan! Silahkan chat bot kamu.");

  // bot.start() HARUS berada di paling bawah setelah semua handler didaftarkan
  await bot.start();
}

main().catch(console.error);

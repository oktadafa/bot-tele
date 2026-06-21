import {
  Chat,
  GenerateContentResponse,
  GoogleGenAI,
  Type,
} from "@google/genai";
import { Bot, Context } from "grammy";
import { hydrateFiles } from "@grammyjs/files";
import * as fs from "fs";
import * as path from "path";
import { Client } from "@notionhq/client";
function splitMessageHTML(text: string, maxLength = 3500) {
  let htmlText = text
    .replace(/^#+\s+(.*?)$/gm, "<b>$1</b>")
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/\*(.*?)\*/g, "<i>$1</i>")
    .replace(/`(.*?)`/g, "<code>$1</code>");

  const lines = htmlText.split("\n");
  const chunks = [];
  let currentChunk = "";

  const tags = [
    { open: "<b>", close: "</b>" },
    { open: "<i>", close: "</i>" },
    { open: "<code>", close: "</code>" },
  ];

  for (const line of lines) {
    if ((currentChunk + line).length > maxLength) {
      let tempChunk = currentChunk.trim();

      let tagsToClose = [];
      for (const tag of tags) {
        const openCount = (tempChunk.match(new RegExp(tag.open, "g")) || [])
          .length;
        const closeCount = (tempChunk.match(new RegExp(tag.close, "g")) || [])
          .length;
        if (openCount > closeCount) {
          tempChunk += tag.close;
          tagsToClose.unshift(tag.open);
        }
      }

      chunks.push(tempChunk);
      currentChunk = tagsToClose.join("") + line + "\n";
    } else {
      currentChunk += line + "\n";
    }
  }

  if (currentChunk.trim() !== "") {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
const bot = new Bot(String(process.env.TELEGRAM_BOT_TOKEN));
const notion = new Client({ auth: String(process.env.NOTION_API_KEY) });

bot.api.config.use(hydrateFiles(bot.token));
bot.use(async (ctx, next) => {
  await next();
});

const ai = new GoogleGenAI({
  apiKey: String(process.env.GOOGLE_API_KEY),
});
const personality = `Kamu adalah seorang dosen yang ramah dan disukai oleh mahasiswa. Kamu selalu memberikan penjelasan yang jelas dan mudah dipahami, serta sering menggunakan contoh untuk membantu mahasiswa memahami konsep yang sulit.`;
const systemInstruction = `Anda adalah mesin ekstraktor data otomatis yang super ketat. 
Tugas Anda HANYA mengubah teks input menjadi ringkasan berformat Markdown standar. 
DILARANG KERAS menyertakan kalimat pembuka (seperti "Berikut adalah ringkasannya..."), kalimat penutup, komentar, atau bersikap seolah-olah Anda adalah manusia/guru. 
Output harus langsung dimulai dengan elemen Markdown (misal ## atau -).`;
const chat = ai.chats.create({
  model: "gemini-3.5-flash",
  config: {
    systemInstruction: personality,
  },
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGeminiWithRetry(
  chatSession: Chat,
  messageText: string,
  systemInstruction = personality,
  maxRetries = 3,
) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await chatSession.sendMessageStream({
        message: messageText,
        config: {
          systemInstruction: systemInstruction,
        },
      });
    } catch (error) {
      attempt++;
      const is503 =
        error.status === 503 ||
        (error.message && error.message.includes("503"));

      if (is503 && attempt < maxRetries) {
        const waitTime = attempt * 2000;
        console.warn(
          `Gemini 503 Error. Retrying attempt ${attempt}/${maxRetries} after ${waitTime}ms...`,
        );
        await delay(waitTime);
      } else {
        throw error;
      }
    }
  }
}

async function main() {
  const databaseId = String(process.env.DATABASE_ID);

  console.log("Bot berhasil berjalan! Silahkan chat bot kamu.");
  bot.on("message:text", async (ctx) => {
    let typeInterval = setInterval(async () => {
      await ctx.api.sendChatAction(ctx.chat.id, "typing");
    }, 2000);

    try {
      chat.sendMessageStream;
      const responseStream = await callGeminiWithRetry(chat, ctx.message.text);
      let fullText = "";
      for await (const chunk of responseStream as AsyncGenerator<
        GenerateContentResponse,
        any,
        any
      >) {
        fullText += chunk.text;
      }
      const chunks = splitMessageHTML(fullText);
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "HTML" });
      }
      clearInterval(typeInterval);
    } catch (error) {
      console.error("Error saat memproses pesan:", error);
      await ctx.reply(
        "Maaf, server AI sedang mengalami antrean padat atau error. Mohon coba lagi beberapa saat lagi.",
      );
    }
    clearInterval(typeInterval);
  });
  bot.on("message:document", async (ctx) => {
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    const fileId = ctx.message.document.file_id;
    const fileInfo = await ctx.api.getFile(fileId);
    const namaFile = ctx.message.document.file_name || "dokumen.pdf";
    const temPath = path.join(process.cwd(), namaFile);
    try {
      const fileUrl = fileInfo.getUrl(temPath);
      const fileFetch = await fetch(fileUrl);
      const fileBuffer = await fileFetch.arrayBuffer();
      const fileBlob = new Blob([fileBuffer], {
        type: ctx.message.document.mime_type ?? "application/octet-stream",
      });
      console.log(`File ${namaFile} sukses diunduh secara lokal.`);
      console.log("Mengupload File Ke Server Notion ...");
      const createFile = await notion.fileUploads.create({
        mode: "single_part",
        filename: namaFile,
        content_type:
          ctx.message.document.mime_type ?? "application/octet-stream",
      });
      console.log(`[1/2] Berhasil membuat file id di Notion: ${createFile.id}`);
      const sendFile = await notion.fileUploads.send({
        file_upload_id: createFile.id,
        file: {
          filename: namaFile,
          data: fileBlob,
        },
      });
      console.log(`[2/2] File berhasil diunggah ke Notion: ${sendFile.id}`);
      console.log(
        "Membuat halaman baru di Notion dengan file yang sudah diupload...",
      );
      await ctx.reply("File berhasil diunggah ke Notion!");
      console.log("[2/3] Mengunggah file ke Google GenAI...");
      const uploadResult = await ai.files.upload({
        file: fileBlob,
        config: {
          mimeType:
            ctx.message.document.mime_type ?? "application/octet-stream",
        },
      });
      console.log(
        "[3/3] File sukses nangkring di Google GenAI:",
        uploadResult.name,
      );
      const geminiFilePart = {
        fileData: {
          fileUri: uploadResult.uri,
          mimeType:
            ctx.message.document.mime_type ?? "application/octet-stream",
        },
      };

      const createSummarize = [
        geminiFilePart,
        "rangkum isi dokumen ini untuk dimasukan ke notion, dengan bahasa yang mudah dipahami oleh mahasiswa pemalas sekalipun.",
      ];
      const responseSummarize = await callGeminiWithRetry(
        chat,
        createSummarize,
        systemInstruction,
      );
      let fullSummarize = "";
      for await (const chunk of responseSummarize as AsyncGenerator<
        GenerateContentResponse,
        any,
        any
      >) {
        fullSummarize += chunk.text;
      }

      const createPage = await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          Materi: {
            title: [
              {
                text: {
                  content: "Percobaan Notion API",
                },
              },
            ],
          },
          "Mata Kuliah": {
            rich_text: [
              {
                text: {
                  content: "Pemrograman Web",
                },
              },
            ],
          },
          Pertemuan: {
            rich_text: [
              {
                text: {
                  content: "Pertemuan 1",
                },
              },
            ],
          },
          "Files & media": {
            files: [
              {
                name: namaFile,
                type: "file_upload",
                file_upload: {
                  id: sendFile.id,
                },
              },
            ],
          },
        },
        markdown: fullSummarize,
      });
      console.log(
        `[1/1] Halaman baru berhasil dibuat di Notion dengan ID: ${createPage.id}`,
      );

      await ctx.reply(
        "Halaman baru berhasil dibuat URL Notion : " + createPage.url,
      );

      const message = [
        geminiFilePart,
        "Jelaskan materi dokumen ini supaya mudah dimengerti oleh mahasiswa pemalas sekalipun.",
      ];
      const responseStream = await callGeminiWithRetry(chat, message);
      let fullText = "";
      for await (const chunk of responseStream as AsyncGenerator<
        GenerateContentResponse,
        any,
        any
      >) {
        fullText += chunk.text;
      }
      const chunks = splitMessageHTML(fullText);
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "HTML" });
      }
    } catch (error) {
      console.error("❌ Terjadi kesalahan proses:", error);
      await ctx.reply(
        "Maaf, terjadi kesalahan saat memproses dokumen kamu di server AI.",
      );
    } finally {
      if (fs.existsSync(temPath)) {
        fs.unlinkSync(temPath);
        console.log(`[Selesai] File lokal ${namaFile} telah dihapus.`);
      }
    }
  });
  await bot.start();
}

main().catch(console.error);

# TranscriptGrab 🎬

A premium YouTube Transcript Downloader tool built with Node.js and modern vanilla web technologies.

## 🚀 Features
- **Instant Extraction**: Extract transcripts from any YouTube video (URL or ID).
- **Format Support**: Supports standard videos, shorts, and embeds.
- **Search & Filter**: Real-time keyword highlighting and line filtering.
- **Multi-Export**: Download as `.txt` (plain text) or `.srt` (subtitles).
- **Content Insight**: Automatic word count, character count, and duration calculation.
- **Dark Mode UI**: Clean, glassmorphic interface inspired by Linear.

## 🛠️ Tech Stack
- **Backend**: Node.js, Express
- **Frontend**: Vanilla HTML / CSS / JS (ESM)
- **Engine**: `youtube-transcript`

## 📦 Installation & Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd youtubetranscriptdownloader
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server**
   ```bash
   npm start
   ```

4. **Visit the app**
   Open `http://localhost:3001` in your browser.

## ⚠️ Known Issues
- YouTube may rate-limit or request a CAPTCHA for some IPs. This is a server-side extraction limit.

## 📜 License
MIT

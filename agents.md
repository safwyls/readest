# Readest Project Documentation

## Overview

**Readest** is an open-source, cross-platform ebook reader application designed for immersive and deep reading experiences. It's a modern rewrite of Foliate that leverages contemporary web technologies to provide smooth reading on macOS, Windows, Linux, Android, iOS, and the Web.

- **License:** AGPL-3.0
- **Repository:** https://github.com/readest/readest
- **Languages:** TypeScript (Frontend), Rust (Native Bridge)

## Architecture

### Hybrid Application Model

Readest follows a **hybrid desktop + web architecture**:

```
┌─────────────────────────────────────────────────┐
│          Frontend Layer (React 19)              │
│    Next.js 16 App Router + TypeScript           │
└────────────┬──────────────────────┬─────────────┘
             │                      │
     ┌───────▼────────┐    ┌────────▼──────────┐
     │   Web Deploy   │    │  Desktop/Mobile   │
     │  (CF Workers)  │    │   (Tauri v2)      │
     └───────┬────────┘    └────────┬──────────┘
             │                      │
     ┌───────▼────────┐    ┌────────▼──────────┐
     │   Edge Runtime │    │   Rust Backend    │
     │   Supabase     │    │   Native Plugins  │
     │   AWS S3       │    │   OS Integration  │
     └────────────────┘    └───────────────────┘
```

### Technology Stack

#### Frontend
- **React 19.2.0** with Next.js 16.0.10
- **TypeScript 5.7.2** for type safety
- **Tailwind CSS 3.4.18** + DaisyUI 4.12.24 for styling
- **Zustand 5.0.6** for state management (14 stores)
- **i18next 24.2.0** for internationalization (53% coverage)

#### Desktop/Mobile
- **Tauri v2.5.1** - Rust-based cross-platform framework
- **Custom Tauri Plugins:**
  - `tauri-plugin-native-tts` - Native text-to-speech
  - `tauri-plugin-native-bridge` - Platform-specific APIs
  - OAuth, WebSocket support

#### Backend/APIs
- **Node.js** with Next.js API routes
- **Edge Runtime** via Cloudflare Workers
- **Supabase** - Authentication and PostgreSQL database
- **AWS S3** - Cloud file storage with presigned URLs

#### Core Libraries
- **foliate-js** - E-book parsing and rendering (custom MIT-licensed package)
- **PDF.js** - PDF rendering
- **highlight.js** - Code syntax highlighting
- **marked 15.0.12** - Markdown parsing

## AI Services & Integrations

Readest integrates several AI-powered services (not generative LLMs, but specialized AI APIs):

### 1. Translation Engine
**Location:** `/src/services/translators/providers/`

**Supported Providers:**
- **DeepL** (primary, quota-based, requires authentication)
- **Google Translate**
- **Azure Cognitive Services Translator**
- **Yandex Translate**

**Features:**
- Automatic language detection
- Translation caching
- Text preprocessing
- Daily quota limits by subscription tier:
  - Free: 10K translations/day
  - Plus: 100K translations/day
  - Pro: 500K translations/day

**Implementation:**
- Abstract factory pattern for provider switching
- Fallback mechanism across providers
- Rate limiting and quota management

### 2. Text-to-Speech (TTS)
**Location:** `/src/services/tts/`

**TTS Implementations:**

1. **EdgeTTSClient** (`edgeTTSClient.ts`)
   - Microsoft Edge TTS
   - Streaming audio support
   - 400+ voices across 140+ languages
   - Server-side streaming via `/app/api/tts/edge/route.ts`

2. **NativeTTSClient** (`nativeTTSClient.ts`)
   - Native OS voices (macOS, Android, Windows)
   - Low latency
   - Offline support

3. **WebSpeechClient** (`webSpeechClient.ts`)
   - Browser Web Speech API fallback
   - Cross-platform compatibility

**Features:**
- Voice selection and preview
- Playback speed adjustment (0.5x - 2x)
- Pitch control
- Sentence-level streaming
- SSML support (Edge TTS)

### 3. Metadata Enrichment
**Location:** `/src/services/metadata/providers/`

**Data Sources:**
- **Google Books API** - Book details, covers, descriptions
- **Open Library** - Alternative metadata source

**Purpose:**
- Automatic book metadata completion
- Cover image fetching
- Author/publisher information

### 4. Planned AI Features

**AI-Powered Summarization** (In Development 🛠)
- Generate chapter/book summaries using AI
- Part of "Advanced AI Tools" in Pro subscription tier
- Implementation status: Planned feature

**Note:** Readest does NOT currently integrate with OpenAI, Anthropic Claude, or other generative LLM services. The "AI" terminology refers to specialized translation engines and TTS synthesis.

## Key Features

### Core Reading Capabilities
- **Multi-Format Support:** EPUB, MOBI, KF8 (AZW3), FB2, CBZ, TXT, PDF
- **View Modes:** Scroll view and paginated view
- **Full-Text Search:** Search across entire books
- **Code Syntax Highlighting:** Rich coloring for technical content
- **Parallel Read:** Split-screen simultaneous reading of two books

### Annotation System
- **Highlighting:** Multiple styles (highlight, underline, squiggly)
- **Color Options:** 5 customizable colors
- **Bookmarks:** Position markers
- **Notes:** Detailed annotations
- **Excerpt Extraction:** Copy text for analysis
- **Dictionary/Wikipedia Lookup:** In-context definitions

### Customization
- **Font System:**
  - Serif fonts (Bitter, Literata, Merriweather)
  - CJK-specific fonts (LXGW WenKai, Source Han)
  - Custom font upload
- **Layout Options:** Margins, columns, spacing, justification
- **Theme System:** Light/dark modes with texture backgrounds
- **Chinese Variant Conversion:** Simplified ↔ Traditional

### Library Management
- **Organization:** Groups, filtering, sorting
- **OPDS/Calibre Integration:** Access online library catalogs
- **Library Sync:** Cross-device progress, notes, bookmarks synchronization

### Advanced Features
- **Proofreading Mode:** Text replacement and correction tools
- **Accessibility:** Keyboard navigation, screen reader support (VoiceOver, TalkBack, NVDA, Orca)
- **KOSync Integration:** Sync with Koreader devices (in development)

## Project Structure

```
readest/
├── apps/
│   ├── readest-app/              # Main application
│   │   ├── src/
│   │   │   ├── app/              # Next.js App Router pages
│   │   │   │   ├── api/          # Backend API routes
│   │   │   │   ├── library/      # Library management UI
│   │   │   │   ├── reader/       # Core reader UI
│   │   │   │   ├── auth/         # Authentication
│   │   │   │   └── user/         # User settings
│   │   │   ├── components/       # Reusable React components
│   │   │   ├── hooks/            # Custom React hooks (25+)
│   │   │   ├── services/         # Business logic services
│   │   │   │   ├── translators/  # DeepL, Google, Azure, Yandex
│   │   │   │   ├── tts/          # Text-to-speech implementations
│   │   │   │   ├── metadata/     # Book metadata providers
│   │   │   │   └── sync/         # Cloud sync logic
│   │   │   ├── store/            # Zustand state stores (14)
│   │   │   ├── utils/            # Utility functions
│   │   │   ├── libs/             # Core libraries
│   │   │   │   ├── payment/      # IAP, Stripe integration
│   │   │   │   ├── storage/      # S3 and Supabase storage
│   │   │   │   └── edgeTTS.ts
│   │   │   ├── types/            # TypeScript definitions
│   │   │   └── styles/           # CSS, fonts, themes
│   │   ├── src-tauri/            # Rust backend
│   │   │   ├── src/
│   │   │   │   ├── lib.rs        # Main Tauri setup
│   │   │   │   ├── transfer_file.rs  # File operations
│   │   │   │   ├── macos/        # macOS-specific code
│   │   │   │   ├── windows/      # Windows-specific code
│   │   │   │   └── android/      # Android-specific code
│   │   │   ├── plugins/          # Custom Tauri plugins
│   │   │   │   ├── tauri-plugin-native-tts/
│   │   │   │   └── tauri-plugin-native-bridge/
│   │   │   └── Cargo.toml
│   │   └── public/               # Static assets
│   └── readest.koplugin/         # Koreader plugin
├── packages/                     # Shared packages
│   ├── foliate-js/              # E-book parsing library
│   ├── simplecc-wasm/           # Chinese conversion (WASM)
│   └── tauri/                   # Custom Tauri fork
└── Dockerfile                    # Docker build (web)
```

## State Management

### Zustand Stores (`/src/store/`)

1. **bookDataStore.ts** - Currently open book data
2. **libraryStore.ts** - Library state and book management
3. **readerStore.ts** - Reader UI and reading state
4. **themeStore.ts** - Theme and appearance settings
5. **settingsStore.ts** - User preferences
6. **proofreadStore.ts** - Proofreading features
7. **parallelViewStore.ts** - Dual-book reading state
8. **notebookStore.ts** - Notes and annotations
9. **sidebarStore.ts** - Sidebar/UI state
10. **deviceStore.ts** - Device capabilities detection

Plus 4 additional specialized stores for specific features.

## Monetization Model

### Subscription Tiers

| Plan | Storage | Translations/Day | AI Features |
|------|---------|------------------|-------------|
| **Free** | 500 MB | 10K | Basic TTS, translations |
| **Plus** | Larger | 100K | Unlimited TTS hours |
| **Pro** | Maximum | 500K | Advanced AI tools (future) |

**Lifetime Purchase Option:**
- One-time payment for specific features
- Expandable storage, customization unlocks

**Payment Integration:**
- Stripe (web)
- Apple In-App Purchase (iOS/macOS)
- Google Play Billing (Android)

## Deployment & Infrastructure

### Web Deployment
- **Platform:** Cloudflare Workers via opennextjs
- **Database:** Supabase (PostgreSQL)
- **Storage:** AWS S3 with CloudFront CDN
- **PWA:** Service Worker (Serwist) + offline support

### Native App Distribution
- **macOS/iOS:** App Store via fastlane automation
- **Windows/Linux:** Direct releases, Flathub for Linux
- **Android:** Google Play Store

### Build Infrastructure
- GitHub Actions for automated releases
- Tauri for cross-platform compilation
- Docker support for web version

## Development Workflow

### Build Commands

```bash
# Desktop development
pnpm tauri dev

# Web development
pnpm dev-web

# Production builds
pnpm build                # Next.js build
pnpm tauri build         # Desktop builds
pnpm tauri android dev   # Android development
pnpm tauri ios dev       # iOS development
```

### Environment Requirements
- **Node.js:** v22+
- **pnpm:** Package manager
- **Rust:** 1.77.2+
- **Cargo:** Rust build tool

## Key API Routes

### Translation API
- `/app/api/translator/[provider]/route.ts` - Translation endpoints for each provider

### TTS API
- `/app/api/tts/edge/route.ts` - Server-side TTS streaming
- Supports voice selection, SSML, and audio streaming

### Metadata API
- `/app/api/metadata/route.ts` - Book metadata fetching

### Cloud Sync
- `/app/api/sync/route.ts` - Library synchronization endpoints

### Payment Processing
- `/app/api/stripe/route.ts` - Stripe webhook handling
- IAP verification endpoints for mobile platforms

## Accessibility Features

Readest is designed with accessibility as a core principle:

- **Keyboard Navigation:** Full keyboard support for all features
- **Screen Readers:** VoiceOver (macOS/iOS), TalkBack (Android), NVDA (Windows), Orca (Linux)
- **High Contrast Modes:** Customizable themes
- **Font Scaling:** Adjustable font sizes
- **TTS Integration:** Built-in text-to-speech for auditory reading

## Contributing

Readest welcomes contributions from the community:

- **Bug Reports:** GitHub Issues
- **Feature Requests:** GitHub Discussions
- **Pull Requests:** Follow contribution guidelines
- **Community:** Active Discord server

## Unique Selling Points

1. **True Cross-Platform:** Same codebase for desktop, web, and mobile
2. **Fully Open Source:** AGPL-3.0 licensed
3. **Privacy-Focused:** Self-hostable components, optional cloud sync
4. **Multi-Language Translation:** Choice of DeepL, Google, Azure, Yandex
5. **Annotation-Rich:** Deep highlighting, notes, excerpts
6. **Accessibility:** Full keyboard navigation, screen reader support
7. **Community-Driven:** Open development, active community
8. **Flexible Monetization:** Generous free tier with optional subscriptions

## Future Roadmap

### Planned Features
- **AI-Powered Summarization:** Generate chapter/book summaries
- **Enhanced KOSync:** Full Koreader device synchronization
- **Additional Translation Providers:** Expand provider options
- **Advanced Analytics:** Reading statistics and insights
- **Social Features:** Reading groups and sharing

## License

**AGPL-3.0** - GNU Affero General Public License v3

This means:
- Free to use, modify, and distribute
- Source code must remain open
- Network use requires source disclosure
- Modifications must use same license

---

**Last Updated:** 2026-01-09
**Project Status:** Active Development
**Community:** Open to contributors

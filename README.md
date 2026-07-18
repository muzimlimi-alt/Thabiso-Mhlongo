# Thabiso Mhlongo Official Website & Admin Console
> *"Officially funny since 2014"*

A high-performance, premium web application built for South African comedian Thabiso Mhlongo. It features a custom booking engine, invoice/contract management with multi-party digital signatures, POPIA-compliant contact inquiry routing, and automated newsletter campaign scheduling.

---

## ── Design System & Brand Identity

The site adheres strictly to the **Editorial-Luxe** visual identity:
*   **Color Palette**: Obsidian primary surfaces (`#0A0A0A`), Section backgrounds (`#111111`), card overlays (`#1A1A1A`), Brand Gold (`#D4AF37`) primary action accents, and strong off-white text (`#FAFAFA`).
*   **Typography**: Headings render in the high-contrast serif font **Cormorant Garamond**; body copy resolves to the modern sans-serif **Outfit**; and system/payment figures use the monospaced **JetBrains Mono**.
*   **Email Aesthetics**: Fully custom responsive email layouts utilizing a single, pre-wrapped HTML wrapper shell with bulletproof VML buttons for flawless rendering across desktop and mobile clients (including Microsoft Outlook).

---

## ── Repository Structure

The project maintains a strict separation of concerns, grouping active code at the root and isolating temporary/scratch resources inside `/TBC`:

```
├── TBC/                        # Temporary, backup, and test files directory (git-ignored)
│   ├── test/                   # Isolated integration test suites, support harnesses, and test DBs
│   ├── db-backups/             # Historical SQLite snapshot files
│   ├── docs/                   # Legacy migration notes and checklist logs
│   ├── images/                 # Unused or legacy design slider mockups
│   └── scripts/                # Unused database repair scripts
├── js/                         # Core utility libraries and pure functional systems
│   ├── emailComponents.js      # Reusable email templates, design tokens, and components
│   ├── bannerRegistry.js       # Dynamic email banner resolution engine
│   └── ...
├── scripts/                    # Production-ready utility and database seeding scripts
│   ├── backup.js               # Automatic SQLite snapshot creator
│   ├── seed-banner-templates.js # Configures database email banners
│   └── ...
├── backups/                    # Auto-generated database backups (git-ignored)
├── database.sqlite             # Production database (SQLite)
├── server.js                   # Express application entrypoint, router, and controller layers
├── database.js                 # SQLite database initialization, schema migration, and seeders
└── package.json                # Project dependencies and script declarations
```

---

## ── Architecture & Key Features

### 1. Booking & Billing Lifecycle
*   **Intake**: Bookings start in the `NEW` state. Quotes are generated with configurable services, quantities, VAT adjustments, and custom expiration dates.
*   **Acceptance & Invoicing**: Client acceptance triggers automatic invoice generation with a configurable 50/50 or custom payment schedule.
*   **Digital Contracts**: Two-party signature workflow: client-signed (validated via access token and timestamp/IP tracking) followed by admin countersigning. Contracts freeze automatically once finalized.
*   **Manual Payments & Refunds**: Admin controls to record manual payments, track scheduled balances, and process full/partial refunds with auto-updating invoice payment statuses.

### 2. CRM & Inquiries (`/api/admin/inquiries`)
*   **Bidirectional Links**: Inquiries can be directly converted into standard bookings.
*   **POPIA Compliance**: Safe user data removal (`/request-forget` endpoint) that anonymizes client details while preserving transaction history and logs.
*   **SLA & Priority**: Automatic flagging for overdue inquiries based on customizable response-time SLAs (defaulting to 24h).

### 3. Campaign & Newsletter Manager
*   **Atomic Claim Engine**: Ensures scheduled newsletters are dispatched reliably without duplicate delivery risks.
*   **Segmentation**: Allows target groupings (e.g. identifying "dormant" subscribers who haven't booked in over 180 days).

---

## ── Local Development

### 1. Prerequisites
*   Node.js (v18 or higher recommended)
*   SQLite3

### 2. Installation
Clone the repository and install npm packages:
```bash
npm install
```

### 3. Environment Setup
Configure your environment variables by replicating the example file:
```bash
cp .env.example .env
```
Ensure database configurations, secrets, ports, and external APIs (such as Google Calendar API credentials and SMTP configurations) are set.

### 4. Run Server
Launch the server in development mode:
```bash
npm start
```
The application will boot, initialize schemas in `database.sqlite` (if missing), and run.

---

## ── Testing & Verification

Integration tests run against a standalone clone of the production database (`TBC/test/.test.sqlite`) inside an isolated server process.

To run the integration tests:
```bash
npm test
```

To take a snapshot backup of the current database:
```bash
npm run backup
```

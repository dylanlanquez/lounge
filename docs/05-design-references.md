# 05. Design references

**Status:** Round 1, awaiting feedback
**Date:** 27 Apr 2026
**Phase:** 2 (per brief §9.2)

This catalogues every inspo file in the repo and synthesises a design language for Lounge. **Iteratively reviewed** — open this doc next to the inspo folders and the Storybook, flag what's wrong, I revise.

---

## 1. Catalogue

### `app-inspo/` (general design references)

| File | What it is | Why it's here |
|---|---|---|
| `original-0cc3082e86533bfa3514690353ead2be.webp` | Multi-screen poster, plant-care-shaped app. Cream background, white cards, forest green accent. Pill buttons. Small mint callouts. | **Primary reference.** This is the Leaf Haven Plants gold standard the brief calls out (§9.2, §9.3). Lounge inherits its surface palette and component shapes. |
| `original-22d83bb32ef4e103718a205e7e38f059.webp` | Pharmacy / health app, "Stone Pharmacy" / "PharmaLife". Light blue-grey background, teal/turquoise primary action, pill buttons, tag chips, big rating cards. | **Reference for layout/shape**, NOT colour. Useful for: tag-chip patterns, rating display, profile-like detail views. The teal palette does not transfer; we stay forest green per brief. |
| `original-2bf42aa531c8ebc52c97e8082a06eb0b.webp` | Leaf Haven order detail page (web). White cards, dark green footer band, ink-on-cream typography, pill buttons (black + outlined), green status pill. | Confirms the desktop language: dark green footer band, big card sections with thin dividers, breadcrumbs, generous spacing. |
| `original-3b266a428f69bdd79603feb0f3f94744.webp` | Leaf Haven account dashboard, address forms, login screen. Rounded inputs, floating labels, sectioned cards, plain text links in green, black-pill primary CTA. | Confirms the form / settings language. Lounge admin and account settings adopt the same pattern. |
| `original-4d4d4dd60332c533025915f13d26dba0.webp` | (small) Single screen reference. | Same family as the rest of Leaf Haven. |
| `original-794fa2b708da5abf02057b82423dbca6.webp` | Leaf Haven personal-info page (desktop). Side nav with "Your Account" stack, active-state with green left bar + green text. Form fields with edit/save inline. Shipping addresses list. Footer dark green. | **Reference for the desktop sidebar.** Brief §9.3 says "240–280 wide. Active item: 2px green left bar + green text + soft green-tinted background." This image is the literal source. |
| `original-b7abbdebc57bbb22be59114f7dc76c26.webp` | Mobile profile screen with floating tab bar (Home/Favorites/Community/Profile). Dark navy primary header, light card list, toggle switches. | Reference for: bottom tab navigation, settings list with toggles, account detail layout. **Palette does not transfer** (uses dark navy, not Lounge's cream). |
| `original-b86b3b6a09348868b88506fd9da51531.webp` | (TBC — to view in next pass) | — |
| `original-d6b4c46ed131a59111d1723449e28fa1.webp` | (TBC) | — |
| `original-d9ed4fa9878bff56e649ce16418b0f99.webp` | (TBC) | — |
| `original-ea5336fd6a13bcf0bc383a120a23e3bb.webp` | (TBC) | — |

(11 files total. 7 viewed and characterised in this round; 4 remain for future passes — they're variations of the Leaf Haven family per filename pattern, not expected to add new design directives. I'll catalogue them as needed when specific components reference them.)

### `calendar-design-inspo/` (4 files)

| File | What it is | Why it's here |
|---|---|---|
| `original-1179bc476890dfe0939856350ba8cb68.webp` | Mobile day-view calendar. Vertical time axis on left, single-column events with **coloured left bar** (purple, blue, mint, etc.), pastel event-card backgrounds. Floating action button stack (orange/green/close) bottom-right. Schedule/Day/Week/Month dropdown. | **Primary calendar reference.** Drives `CalendarGrid` + `AppointmentCard` patterns. Coloured left bar = status indicator. |
| `original-6af0f5795011c685ca883f765403ffe4.webp` | Desktop week-view calendar. 7 columns, time on left. Events as soft-tinted blocks. Side panel with mini month calendar (today pill highlight) + categories list (checkbox + line indicator). | Reference for: desktop week view, mini-month calendar widget, "Categories" filter list. |
| `original-e639dfee9dfe9eb7baea77041c2da6c2.webp` | Desktop calendar with vertical sidebar nav, share dialog, event cards with **DEV/DESIGN/HRD tag pills**, attendee avatar stack. | Reference for: tag pills on appointments, desktop sidebar shape, share-link UI (out of scope v1 but shape is reusable). |
| `original-e6b1173f220066ff39887f3c9051159f.webp` | Mobile day view zoom-in. Same as the first calendar image but closer. Floating FAB stack visible. **Now-indicator** orange line across top. | Reference for now-indicator (orange/red horizontal line, brief §9.4.6 calls for accent green — we'll use green not orange). |

### `epos-inspo/` (2 files)

| File | What it is | Why it's here |
|---|---|---|
| `original-28a0f7fb8048cc4a4e88d94b40dc3846.webp` | Nike POS, small. Dark left sidebar with icons. White card grid (3 cols) of product tiles with stock badges, image, title, description, price, "Add to Cart" pill. Right rail: detail transaction with line items + qty stepper, total breakdown, "Continue" pill. | **Primary EPOS reference.** Drives `Cart` + `CartLineItem` + product-tile grid pattern. The "Add to Cart" pill on each tile = our "Add this line to cart" pattern. |
| `original-58221b83a008d6cfb9a92ca62b6a7e91.webp` | Same Nike POS, full size. Shows: stock badge top-left of tile, photo dominates, "Add to Cart" pill bottom of tile. Right rail line item: photo, title, **size/color tag pills**, qty stepper, delete (red icon). Promo highlight banner. **Credit Card** payment method row with "Change Method" link. **Lime green** "Continue" pill. | Layout confirmed: 2/3 left for cart, 1/3 right for payment. Lime green CTA does **not** transfer (we use forest green per brief). |

### `logos/`

| File | Purpose |
|---|---|
| `lounge-fav.png` | Favicon + app icon. Teal background, navy "L". 512×512px (verified). |
| `lounge-favicon.ai` | Adobe Illustrator source for the favicon. |
| `lounge-favicon.png` | Alt-size favicon. |
| `lounge-logo.png` | In-app wordmark. Black "lounge" lowercase on transparent background. |
| `lounge-logo.pdf` | Vector source for the wordmark. |

---

## 2. Synthesised design language

### 2.1 Palette (locked, matches brief §9.3)

| Token | Hex | Use |
|---|---|---|
| `bg` | `#F7F6F2` | Cream page background |
| `surface` | `#FFFFFF` | Cards |
| `ink` | `#0E1414` | Primary text, primary buttons |
| `inkMuted` | `rgba(14,20,20,0.6)` | Secondary text |
| `inkSubtle` | `rgba(14,20,20,0.4)` | Tertiary text, placeholder |
| `accent` | `#1F4D3A` | Forest green for action accents, links, success |
| `accentBg` | `#E8F5EC` | Mint callout background |
| `alert` | `#B83A2A` | Single red, used sparingly |
| `border` | `rgba(14,20,20,0.08)` | Hairline dividers |

The favicon's bright teal is **brand-icon-only** — it does NOT appear in app chrome (per `01-architecture-decision.md §6` resolution). The app palette is cream + white + forest green + ink, exactly as the brief specifies and the Leaf Haven inspo confirms.

### 2.2 Typography (locked)

- **Family:** Inter, with SF Pro Text fallback on Apple devices.
- **Scale (px):** 12, 14, 16 (base), 18, 22, 28, 36, 48, 64.
- **Weights:** 400, 500, 600, 700.
- **Line height:** 1.15 (tight) for display text, 1.5 (normal) for body, 1.65 (relaxed) for paragraphs.
- **Tracking:** -0.01em on display text.

### 2.3 Shape and motion

- **Cards:** 18px radius, soft shadow `0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)`.
- **Inputs:** 14px radius, 56px tall on tablet, 2px forest-green focus ring at 32% opacity.
- **Buttons:** Pill (`border-radius: 999px`), 56px primary height on tablet.
- **Modals:** Bottom sheet on tablet/mobile, centred dialog on desktop.
- **Motion:** Spring `cubic-bezier(0.25, 1, 0.3, 1)` at 240ms. No linear easings.

### 2.4 Spacing

8-point grid, with these tokens: 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96.

### 2.5 Status colour decisions for the calendar (per brief §9.4.4)

| Status | Visual treatment |
|---|---|
| Booked | Neutral / ink (border only, no fill) |
| Arrived | Forest-green fill, white text |
| In progress | Forest-green outline (no fill) |
| Complete | Muted ink (greyed out) |
| No-show | Red outline (single alert colour) |
| Cancelled | Strikethrough text, separate "cancelled today" subsection |

These are the **only** colours on the calendar. No multi-colour event tags like the calendar inspos (purple, blue, mint, etc.) — those are Notion/Calendly conventions, not what Lounge needs.

### 2.6 Layout decisions

#### Calendar (per brief §9.4)

- **Today / Day view:** Vertical time grid, time labels on left (12px muted), now-indicator forest-green line + label bold. Horizontal columns per staff member.
- **Week view:** 7 columns, days across top.
- **Appointment card:** Coloured left bar (status colour) + ink text + time/duration row.
- **Tap interactions:** Single tap opens detail bottom sheet (no long-press).

#### EPOS (per brief §9.5)

- **Tablet landscape (primary):** Cart on left 2/3, payment summary on right 1/3.
- **Cart line items:** Card-shaped rows, photo + title + qty stepper + line total + remove. Soft shadow.
- **Total in display-size typography (48–64px)** — unmissable.
- **"Take payment" pill anchored bottom-right** when cart has items.
- **Cash mode:** Numeric keypad for amount tendered, change calculated live above.

#### Sidebar (desktop only, per brief §9.3 + Leaf Haven inspo)

- 240–280px wide.
- Active item: 2px green left bar + green text + soft green-tinted background (`accentBg`).
- Section headers in `inkSubtle`.
- Footer band at bottom: dark green / near-black with white text (Leaf Haven-style).

### 2.7 Imagery rules

- Patient avatars use Meridian's existing avatar system (`avatarPresets.js`).
- No stock photography in the app.
- No emoji in UI text.
- Illustrations only where they earn their place (empty states, success screens).

---

## 3. Open questions / iterations needed

### 3.1 The favicon palette conflict (R20 in `00-discovery.md`)

**Resolution proposed in `01 §6`:** keep app palette as forest green + cream + ink; favicon's teal/navy stays at icon level only.

**For your review:** at Phase 2 end, do you want me to redesign the favicon to match the app palette (forest green background, navy "L"), or are you happy with the teal favicon being a brand-edge accent?

### 3.2 Now-indicator colour

Brief §9.4.6 says "horizontal accent green line." Calendar inspos use red/orange. I'll use forest green per brief. **Confirm or override.**

### 3.3 BNPL payment-method tile colour

The PaymentMethodSelector (component #21) needs three pills: Card, Cash, Buy now pay later. BNPL tile expands to Klarna / Clearpay choice. **Should the BNPL pill have visual distinction** (e.g., subtle accentBg fill) to telegraph "this opens a guided flow", or look identical to Card and Cash? My lean: subtle accentBg fill so the receptionist doesn't mistake it for a one-tap option.

### 3.4 Receipt channel selector layout

SegmentedControl with four options (Print / Email / SMS / None) per brief §9.7 #25. **Print should be disabled and labelled "v1.5"** for now since no printer is paired (per `00 R19`). Confirm.

### 3.5 Tablet density

Brief §9.4.5 sets "default 1 hour = 80px" for the calendar. Pinch-to-zoom adjusts. **Confirm 80px feels right** when you see it in Storybook.

---

## 4. Next iteration plan

**Round 2 (after your review of components 1–3):** if palette + shape are accepted, I build components 4–10 (BottomSheet, Dialog, Toast, Skeleton, EmptyState, StatusPill, SegmentedControl).

**Round 3:** components 11–14 (Sidebar, Breadcrumb, Avatar, KeyboardAwareScroll).

**Round 4:** the calendar primitives (15–18: CalendarGrid, AppointmentCard, SlotPicker, PatientTimeline). This is the biggest chunk — needs your iteration.

**Round 5:** EPOS primitives (19–25: Cart, CartLineItem, PaymentMethodSelector, NumericKeypad, TerminalPaymentModal, BNPLHelper, ReceiptChannelSelector).

After round 5, design system signed off, Phase 3 slices begin.

---

*Last updated 27 Apr 2026.*

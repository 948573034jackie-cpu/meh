# Eye Care Colors — a Chrome extension

One button, six choices. Repaints **any** web page — articles, online books, web apps, images and videos — in colors that are easier on your eyes.

| Mode | Looks like | When to use it |
|---|---|---|
| **Original** | the page as it was | turn everything off |
| **Paper** | cream `#F5EEDC` with charcoal `#2E2A24` text | daytime reading; softer than bright white |
| **Book** | warm sepia `#F1E3C4` with brown `#4A3B2A` text | long reading sessions, like an old book |
| **Blue-light filter** | page keeps its colors, with a warm amber tint | evening, when colors still matter (photos, video) |
| **Dark** | dark gray `#1F1F1F` with light gray `#DADADA` text | dim rooms and at night |
| **Night** | very dark brown `#1E1A16` with amber `#E3C9A5` text | the last hour before bed (dark *and* low blue) |

You also get:
- A **brightness** slider (40–100%) that dims the page further.
- **Pause on this site** for any website you want left alone.
- Keyboard shortcuts: **Alt+Shift+E** switches Original ↔ your last mode, and **Alt+Shift+N** goes to the next mode.

## Install (2 minutes)

1. Download this repository, either with `git clone` or **Code → Download ZIP** on GitHub (then unzip it).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and choose the folder that contains `manifest.json`.
5. Click the puzzle-piece icon in the toolbar and **pin** “Eye Care Colors”. Click the eye icon to pick a mode.

Your choice applies to all tabs at once and is remembered. If you're signed in to Chrome, it also syncs to your other computers.

## What the research says (and how it shaped the colors)

- **Pure white is harsh; pure black text on it is too stark.** A very bright white background makes the eye work against glare. Eye-strain guides recommend warm off-whites (cream, sepia) with charcoal text rather than black-on-white. → *Paper* and *Book* turn white into cream/sepia and lift black text to charcoal/brown. Contrast stays high (about 12:1 and 8:1, both above the WCAG AAA 7:1 level), but less extreme than 21:1.
- **Dark mode helps in dim light, but pure black is not ideal.** White text on pure black “glows” and blurs (halation), especially for the roughly 50% of people with some astigmatism. Material Design and accessibility guides recommend dark gray (around `#121212`–`#282828`) with off-white text. → *Dark* uses `#1F1F1F` with `#DADADA` (about 12:1 contrast). Light, positive-polarity modes (*Paper*/*Book*) remain the better daytime choice, because studies also find more fatigue from dark mode during long use in bright rooms.
- **Blue light at night affects sleep.** Light around 460–480 nm (peaking near 464 nm) most strongly suppresses melatonin through the eye's melanopsin cells. Evening screen use delays sleep, and filtering short wavelengths reduces that effect. → *Blue-light filter* multiplies the page by an amber tint, roughly a 3400 K “warm lamp”, which cuts the blue channel by about 37%. *Night* combines a dark background with amber text, cutting blue even more.
- **Brightness matters as much as color.** A screen that is much brighter than the room is a major cause of strain. → The brightness slider dims the page itself, beyond your monitor's minimum.
- **Breaks matter most.** No color fixes staring for hours. The popup reminds you of the **20-20-20 rule**: every 20 minutes, look 20 feet (6 m) away for 20 seconds.

A note on the popular “eye-protection green” (豆沙绿 `#C7EDCC`): it's widely used, but there's little research showing it beats a warm off-white. That's why the extension uses the better-supported Paper and Book tones instead.

Sources:
- [Immediate Effects of Light Mode and Dark Mode Features on Visual Fatigue in Tablet Users (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12027292/)
- [The Best Screen Colors for Reducing Eye Strain](https://colorscreen.dev/articles/best-colors-for-reducing-eye-strain/)
- [Is sepia mode the default feature? — Blog on Digital Accessibility](https://a11y-blog.dev/en/articles/is-sepia-mode-essential/)
- [Is Dark Background Better for Your Eyes? — ScienceInsights](https://scienceinsights.org/is-dark-background-better-for-your-eyes/)
- [Why Dark Mode Can Make Astigmatism Worse (Halation)](https://www.astigmatismofit.com/blog/dark-mode-vs-light-mode-astigmatism)
- [Dark Mode Contrast: WCAG-Compliant Dark UI — ColorContrast](https://www.colorcontrast.org/blog/dark-mode-contrast-accessibility-guide/)
- [Dark mode & accessibility myth — Stéphanie Walter](https://stephaniewalter.design/blog/dark-mode-accessibility-myth-debunked/)
- [Blue light, melatonin and sleep — Frontiers in Neurology (2025)](https://www.frontiersin.org/journals/neurology/articles/10.3389/fneur.2025.1699303/full)
- [Analysis of circadian properties and healthy levels of blue light from smartphones at night — Scientific Reports](https://www.nature.com/articles/srep11325)

## How it works

The extension places two see-through, click-through layers over the page in Chrome's “top layer”:
- A *screen* layer raises black up to the mode's text color.
- A *multiply* layer lowers white down to the mode's paper color.

Together they remap every pixel to the mode's palette, including text, pictures, video and canvas. For **Dark** and **Night**, a light page is first inverted with a CSS filter, and photos and videos are flipped back so they keep their real colors. If a site already has a dark theme (for example YouTube in dark mode), it isn't inverted; it only gets warmed and dimmed. Fullscreen video and pop-up dialogs are handled too.

## Limits

- Chrome doesn't let extensions run on `chrome://` pages, the Chrome Web Store, or Chrome's built-in **PDF viewer**. For PDF books, open them in a web reader (for example Google Drive's viewer), or use the Blue-light filter in your operating system (Night Light on Windows, Night Shift on macOS).
- To use it on local files (`file://`), open `chrome://extensions` → Eye Care Colors → **Details** and turn on **Allow access to file URLs**.
- Requires Chrome 114 or newer (or Edge, Brave, or another Chromium browser of the same age).

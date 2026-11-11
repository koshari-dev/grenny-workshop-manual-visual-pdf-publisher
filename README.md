# Grenny Workshop Manual Visual PDF Publisher

A local control panel and Docker-based publisher for creating visual PDF workshop manuals from supported workshop procedure topics.

The publishing engine is included as a pinned Git submodule.

## Requirements

- Linux Mint or compatible Linux
- Node.js 20 or later
- Docker Engine and Docker Compose plugin
- A modern web browser
- Your own authorised workshop source files and supporting data

## Workshop files

This repository does not include workshop manuals, topic libraries, Cortona runtime files or workshop tree data.

Supply your own paths in `.env`. You must have the necessary rights to access and process the supplied material and software.

## Installation

Clone the repository with its engine submodule:

    git clone --recurse-submodules https://github.com/koshari-dev/grenny-workshop-manual-visual-pdf-publisher.git
    cd grenny-workshop-manual-visual-pdf-publisher

If the engine submodule was not downloaded:

    git submodule update --init --recursive

Copy the example configuration:

    cp .env.example .env
    chmod 600 .env

Edit `.env` and configure:

- `WORKSHOP_SOURCE_DIR` — workshop topic source directory
- `WORKSHOP_RUNTIME_DIR` — authorised Cortona runtime directory
- `WORKSHOP_TREE_DIR` — workshop tree data directory
- `PDF_OUTPUT_DIR` — generated PDF destination
- `PDF_WORK_DIR` — publication working directory

Set `PUID` and `PGID` to the values returned by `id -u` and `id -g`.

The example configuration uses a sample size of 10 procedures. Review the settings before starting a publication.

## Start

    chmod +x Start-Grenny-PDF-Publisher.sh
    ./Start-Grenny-PDF-Publisher.sh

Open http://127.0.0.1:4177 in your browser.

Keep the terminal open while using the control panel. Press Ctrl+C to stop it.

The control panel listens on the local machine only.

### Optional hardware-accelerated rendering

The default configuration runs the publishing container with network access
disabled. For hardware-accelerated rendering, the publisher can connect to a
separate Brave browser running on the host through Chrome DevTools Protocol
(CDP).

1. Install Brave on the Linux host and confirm that its GPU acceleration works.
2. Start a separate Brave instance with its own profile and a loopback-only
   debugging endpoint:

       brave-browser --user-data-dir="$HOME/.cache/brave-pdf-cdp" --no-first-run --no-default-browser-check --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --enable-gpu --enable-webgl about:blank

   Keep this browser instance running while publishing. Its profile is
   separate from your normal Brave profile.
3. In `.env`, set:

       PDF_GPU_MODE=brave-cdp
       PDF_BROWSER_CDP_URL=http://127.0.0.1:9222

4. Start or restart the control panel and use it normally.

To return to the standard isolated Docker mode, set `PDF_GPU_MODE=off`.

The GPU mode uses host networking for the publishing container so it can reach
the host browser. Keep the Brave debugging endpoint bound to `127.0.0.1`;
do not expose the CDP port to your network. GPU acceleration depends on the
host browser, graphics drivers and hardware. Check `brave://gpu` in Brave if
hardware acceleration is not being used.

## Publication safety

- Sample mode processes the configured sample size.
- Selection mode uses the saved procedure selection.
- Full-library publication requires explicit confirmation in the control panel.
- Use separate output and working directories for separate publisher installations.
- Do not share private configuration, source files, runtime files or generated publications without permission.

## Engine

The `engine/` directory is the `workshop-pdf` Git submodule, pinned to a specific revision. Engine updates should be deliberate and tested before changing the pinned revision.

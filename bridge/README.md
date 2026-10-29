# Delicate Bridge

A small helper that runs on your Mac and lets Delicate Studio reach the CD drive. Browsers cannot read a drive themselves.

Studio connects to it at `ws://127.0.0.1:47391`. Only pages from `https://studio.delicateaudio.com` are accepted, and each browser is paired once with a six-digit code that the Bridge prints in its window.

## Build

Install Rust once:

    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

Then, from the repository:

    cd bridge
    cargo build --release

## Run

    ./target/release/delicate-bridge

Leave the window open while you rip. In Studio, open Import a CD, click Connect, then Pair, and type the code the window shows.

## What it does

- Reads the table of contents, the pregaps (INDEX 00 from the Q subchannel), a hidden first track, ISRC, MCN and CD-Text from the disc.
- Secure rip: every window of sectors is read twice and compared; sectors that differ, or that the drive flags with C2 error pointers, are re-read with the drive cache bypassed until two reads agree. Sectors that never agree are reported as suspect.
- Streams the audio to Studio, which checks it against AccurateRip and corrects the read offset (from AccurateRip, or from the AccurateRip drive list when the disc is unknown).

## Options

- `--port N` another port
- `--state DIR` where the pairing tokens are kept (default `~/Library/Application Support/Delicate Bridge`)
- `--sim DIR` a simulated drive (`spec.json` and `disc.raw`) for tests

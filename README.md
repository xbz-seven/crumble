# Crumble

Packs files into `.crumbs` archives. Encrypts them too if you want.

Sort of like a torrent manager crossed with WinZip, minus the sketchy trackers and executable payloads. Drag files in, set a password, get a `.crumbs` file out. Send it to someone, they open it in Crumble, pick what they want, extract.

Wanted something I could trust to not run random code when I unpack.

## Install

### Arch (AUR)
```
yay -S crumble
```

### Manual
```
npm ci
npm run build
cargo build --release --manifest-path src-tauri/Cargo.toml
```

Binary ends up at `src-tauri/target/release/crumble`.

## How it works

1. Pick files, optionally set a password -> gets compressed, encrypted, written to a `.crumbs` file
2. Send the `.crumbs` to someone
3. They open it, see what's inside, pick what to extract, choose where it goes

Encryption chain: Argon2 -> AES-256-GCM -> XOR shuffle. Compression with zstd before all that.

## Tabs

- **Pack** — drag files/folders in or pick them, set password, pack
- **Unpack** — open a `.crumbs`, scan contents, toggle files, pick destination, install

## Why

WinZip can run malicious stuff on extract. Torrent clients have trackers. Wanted something that just extracts files and nothing else.

## Author

xbz7

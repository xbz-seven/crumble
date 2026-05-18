# Crumble

A file packing and encryption tool. Like a torrent manager, just without the sketchy trackers.

Inspired by torrent managers and WinZip - but WinZip has the problem of being able to execute malicious actions if you're not careful with what you extract. Crumble avoids that.

Crumble ALSO compresses files to the best it to its ability. Making it easier to send big files to another user.

## How it works

1. **Pack** - Select files, set a password (optional), and Crumble encrypts & compacts everything into a `.crumbs` file.
2. **Share** - Send the `.crumbs` file to someone else.
3. **Unpack** - They open it in Crumble with the password, choose which files to extract, and install them to a destination folder.

No sketchy trackers. No executable payloads. Just encrypted, packed files.

## Usage

- **Pack tab:** Drag in files/folders or use the file picker, set a password, and click Pack.
- **Unpack tab:** Open a `.crumbs` file, scan its contents, toggle which files you want, pick a destination, and install.
- **Library tab:** View previously packed packages and re-install them.

## Building

```
npm install
npm run tauri build
```

The compiled binary will be in `src-tauri/target/release/`.

## Author

**xbz7** - updates will try to be pushed regularly.

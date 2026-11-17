# Pine on a phone (prototype)

The desktop app's page (`../desktop/src`) in a Capacitor app for iOS, talking to the pine on
your computer. Only the parts a phone needs are its own:

| File | What it is |
|---|---|
| `src/bridge.ts` | `window.pine` for a phone: the same names as `desktop/electron/preload.ts`, each handed to the native side. What a phone cannot do (a folder, a terminal, dictation) says so |
| `src/main.tsx` | Pairing (address and token), then the desktop's `App`; the side bar as a drawer |
| `src/mobile.css` | The desktop's styles on a narrow screen |
| `ios/App/App/Pine.swift` | What `desktop/electron/main.ts` is on a computer: the token in the Keychain, every call to the control API, the event stream, pictures through `pine-media:` (the same `MEDIA` list), and only web addresses opened, in Safari |
| `test/page.test.ts` | The page in WebKit at a phone's size, on a stand-in for `Pine.swift`, against a pine of its own on the scripted model |

As on the desktop, the page holds no token and makes no request itself: the control API refuses
any request with an `Origin`, and the native side sends none.

## Run it

```bash
npm install            # here, and in ../desktop (the page's packages are the desktop's)
npm run build          # the page, copied into the iOS project
open ios/App/App.xcodeproj
node --test test/page.test.ts   # the page, without a phone
```

The iOS Simulator shares this computer's loopback: pair it with `http://127.0.0.1:7463` and the
token `pine service` prints.

## Not solved yet

- **Reaching pine from a real phone.** The control API listens on `127.0.0.1` and accepts only
  a loopback `Host` (or `http.host`). A phone on Tailscale could reach it through
  `tailscale serve`, if the `Host` it forwards is accepted; that is not tried. Whatever it is
  should be decided with the maintainers before this goes further.
- **Pairing without typing the token**, for example a QR code shown by the desktop app.
- **Notifications** while the app is in the background (the event stream stops there).
- **Long-press menus** (`bridge.contextMenu` shows nothing), the code panel, and Android.

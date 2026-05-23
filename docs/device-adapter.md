# Device Adapter Boundary

`LightDeviceAdapter` is the only app surface that writes to DX Light hardware.

```ts
interface LightDeviceAdapter {
  readonly label: string;
  isSupported(): boolean;
  connectPaired(): Promise<LightDeviceInfo | null>;
  connect(): Promise<LightDeviceInfo | null>;
  disconnect(): Promise<void>;
  writeFrame(frame: LedFrame): Promise<DeviceWriteResult>;
}
```

The current implementation provides `BrowserHidLightDeviceAdapter` for a safe WebHID path. It keeps W1 constraints local to the adapter:

- LED chain frames are serialized by `createSyncScreenPayload` using the manufacturer `SC` / `setSyncScreen` action `0x80` packet shape discovered in the installed DX Light app.
- Device metadata is queried with the manufacturer `RB` / `readDeviceInfo` action `0x82` packet when WebHID input reports are available.
- Previously paired WebHID devices are opened with `connectPaired()` so the app can auto-connect after the browser permission has been granted once.
- WebHID prompts are filtered to the confirmed ROBOBLOQ monitor light control interface: vendor `6790` / product `65031` / usage page `0xff00`.
- HID writes are split by `chunkPayload` with a 64 byte ceiling.
- Reports are paced with an injected sleep interval.

The installed DX Light native modules are only used for protocol inspection and hardware smoke checks. Runtime writes stay inside WebHID so the app remains browser-based and the hardware boundary stays isolated.

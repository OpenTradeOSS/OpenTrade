# OpenTrade for iPhone

Expo app (SDK 57) for OpenTrade Cloud: approve agents' orders (Face ID), and watch agents,
portfolio and activity. It talks only to the gateway (`EXPO_PUBLIC_GATEWAY_URL`, default
the staging gateway) with a bearer session token kept in the keychain. It sells nothing;
plans and credits are managed on the web.

```bash
npm install
npx tsc --noEmit
npx expo start                     # dev
```

## Release (EAS)

Bundle ID `ai.exla.opentrade.mobile`, team Exla Corp (`P76SY8RFGL`). Builds run on EAS
(`@birud/opentrade`) with local credentials: an App Store distribution certificate and
profile created through the App Store Connect API, referenced by the gitignored
`credentials.json`.

```bash
eas build --platform ios --profile production --non-interactive
eas submit --platform ios --id <build-id>
```

Push notifications need an APNs key uploaded to EAS (`eas credentials`), since Expo's
push service delivers through APNs.

Store listing and review notes: `store/metadata.md`.

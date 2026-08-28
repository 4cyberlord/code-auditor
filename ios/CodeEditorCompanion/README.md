# Council Editor Companion

Native iOS companion foundation for Council Editor.

The app registers for APNs, sends the device token to the worker server and
reads cloud job history from Supabase. Apple Watch support comes through normal
iPhone notification mirroring; a dedicated watchOS app is not required for v1.

Required configuration in the app target's `Info.plist` or build settings:

- `CODE_EDITOR_SUPABASE_URL`
- `CODE_EDITOR_SUPABASE_ANON_KEY`
- `CODE_EDITOR_DEVICE_REGISTRATION_URL`
- `CODE_EDITOR_DEVICE_REGISTRATION_TOKEN`

Backend endpoint:

- `POST /api/register-device`

The device-registration token is not a Supabase service-role key. It should match
`CODE_AUDITOR_DEVICE_REGISTRATION_SECRET` on the worker server.

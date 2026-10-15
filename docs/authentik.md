# Sign in with authentik

greydoc signs people in with OpenID Connect. These steps connect it to authentik. In the examples, greydoc runs at `https://notes.example.com` and authentik at `https://auth.example.com`.

## In authentik

1. Go to **Admin interface**, then **Applications**, then **Applications**, and press **Create with provider**.
2. Application: set **Name** to `greydoc` and **Slug** to `greydoc`. The slug is part of the issuer URL.
3. Provider type: choose **OAuth2/OpenID Provider**.
4. Provider settings:
   - **Authorization flow**: `default-provider-authorization-implicit-consent` skips the consent screen. Use the explicit flow if people must confirm.
   - **Client type**: `Confidential`.
   - **Redirect URIs**: `Strict`, `https://notes.example.com/auth/callback`.
   - **Scopes**: keep `openid`, `email` and `profile`. The `profile` scope sends the user's groups in the `groups` claim.
   - **Subject mode**: `Based on the User's UUID`. greydoc uses the subject as the stable user ID, so do not change it later.
5. Copy the **Client ID** and **Client Secret**.
6. To limit who can sign in, open the application, go to **Policy / Group / User Bindings**, and bind the groups that may use greydoc. Without a binding, every authentik user can sign in.
7. Optional: create a group, for example `greydoc-admins`, for people who may see the whole audit log and every note in the trash.

## In greydoc

Set these variables, for example in `.env` next to `docker-compose.yml`:

```bash
GREYDOC_BASE_URL=https://notes.example.com
GREYDOC_OIDC_ISSUER=https://auth.example.com/application/o/greydoc/
GREYDOC_OIDC_CLIENT_ID=<client id>
GREYDOC_OIDC_CLIENT_SECRET=<client secret>
GREYDOC_ADMIN_GROUP=greydoc-admins
```

The issuer is authentik's URL, `/application/o/`, and the application slug. greydoc reads `<issuer>/.well-known/openid-configuration` at start. Leave `GREYDOC_OIDC_GROUPS_CLAIM` at its default, `groups`.

Restart greydoc: `docker compose up -d`. Open greydoc and press **Sign in**.

## Check

- Open `https://auth.example.com/application/o/greydoc/.well-known/openid-configuration`. It must return JSON.
- After sign-in, the account menu shows your name. `https://notes.example.com/api/me` lists your groups.
- If the sign-in fails with `sso_state_mismatch`, the cookie did not survive the redirect. Check that `GREYDOC_BASE_URL` is the exact address people use, with `https`.

## Things to know

- Groups come from authentik at each sign-in. A group change applies at the next sign-in.
- When OIDC is on, local mode is off: pages need sign-in, except view-only links and notes open to anyone with the address.
- In local mode, every note belongs to the user `local`. After you turn on OIDC, these notes have no real owner. Admins still see them in the audit log.
- MCP clients need no setup in authentik. They sign in through greydoc, which sends people to authentik.
- Sign-out ends the greydoc session only. The authentik session stays.

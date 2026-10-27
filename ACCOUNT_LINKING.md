# Foundry account linking

## Not SSO

The website authenticates members with Discord OAuth. Foundry users are local
to a particular world. A module can read the active Foundry user's ID, but a
website request made by module JavaScript cannot prove that the ID came from an
authenticated Foundry session: the client can be modified and its requests can
be forged.

For that reason, account linking should be treated as an association between
two profiles, not as single sign-on. It must not log a user into either
service, grant website permissions, or replace existing character and campaign
authorization checks. The module must never ask for or store a Discord
password, OAuth token, website session cookie, bot API key, or Foundry admin
credential.

## Member Foundry passwords (proposed)

The connector account's password is separate from member Foundry passwords and
must never be sent to the Website. If members set their Foundry passwords in
their Website profiles, the browser should encrypt each password with the
linked world's public key before sending it to the Website. The Website would
store only ciphertext for the module to replay when the world is open.

The Foundry module would keep the private key encrypted in world data under a
separate connector passphrase. Only the designated connector user should unlock
it, and that passphrase must be entered in each browser session rather than
stored in the Website or Foundry settings. This allows different browsers to
connect to the same world while keeping the Website server from decrypting the
queued passwords. The password is still present in the member's browser when
entered and in the connector GM's client while it is applied; this does not
protect against compromised browser code or a malicious GM. Losing the
connector passphrase makes queued ciphertext unrecoverable, so members would
need to reset their passwords.

This is a proposed design. The current module prototype only tests world-key
creation, connector unlock, and local password encryption/decryption; it does
not yet link campaigns or send password updates through the Website.

## Low-risk linking flow

For profile display or other non-authorizing conveniences, a first version
could work as follows:

1. A member signs into the Dragonmyth website and requests a Foundry link.
   The website issues a random, one-time code scoped to that Discord account,
   expiring after a short period and stored only as a hash.
2. While signed into a Foundry player account, the member enters the code in a
   module dialog. The module submits the code, the current world's identifier,
   and `game.user.id` to a website endpoint.
3. The website consumes the code once and records the asserted Foundry user
   association. The web profile displays the linked world and Foundry user;
   either side can revoke the link.

The code proves control of the website account. It does **not** prove that the
submitted Foundry user ID belongs to the person who requested the code. The
website must therefore label this association unverified and restrict it to
non-sensitive display/convenience features. A world/user association should
use stable Foundry IDs rather than display names and be scoped to a specific
world; if multiple Foundry installations are supported, the world scope needs
an installation-specific identifier rather than only a world slug.

## Campaign-to-world pairing

The current prototype's campaign ID is a public locator, not a credential. A
campaign GM requests a short-lived, one-time pairing code from the authenticated
campaign settings page. The Foundry connector exchanges that code together
with its installation ID, world ID, system version, and public encryption
key. The Website stores a one-campaign-to-one-Foundry-world association; a
pairing code is required even when the campaign ID is known.

This proves that the code issuer authorized a campaign link, but it does not
make client-reported Foundry details cryptographically trustworthy. The
pairing token is therefore narrowly scoped to that campaign and world. It
must not grant Website permissions, and roster roles must continue to be
calculated by the Website rather than accepted from Foundry client requests.

## Before using a link for permissions

Do not use a client-reported Foundry ID to grant character access, campaign
roles, ownership, or website login. Those actions need a trusted identity
assertion, not just a successful code exchange. A confirmation button or
`game.user.isGM` check in module JavaScript is also client-controlled; it is
not, by itself, proof to the website that a GM approved the link.

If links are ever used for authorization, first design a server-verifiable
approval mechanism (for example, a trusted Foundry-side integration or a
separate, auditable human verification process). Keep that authority separate
from the current character-sync token, enforce permissions on the website, and
provide revocation and audit history.

## Relationship to the current prototype

The current pairing flow links one website character to one Foundry Actor. It
does not link a member's Discord profile to a Foundry user account. Actor
ownership is selected manually in Foundry, and the scoped character-sync
token remains separate from any future account-link record. See
[the module README](./README.md#pair-a-character) for the existing prototype.

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

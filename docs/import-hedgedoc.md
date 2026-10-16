# Import from HedgeDoc 1

greydoc can take over a HedgeDoc 1 server's documents with their links, dates and permissions. Every old link keeps working, as long as the greydoc server answers on the same host name.

## Links that keep working

A HedgeDoc 1 document answers to three IDs:

| ID | Where it comes from | Example |
|---|---|---|
| Free alias | `Notes.alias`, only for documents created with a free URL | `team-standup` |
| Document ID | `Notes.id` (a UUID), as base64url | `s3BkeGgqTH-gU5UXqMZdag` |
| Short ID | `Notes.shortid` | `SyJdkz5Jx` |

Import each document with the alias if it has one, else the document ID, as `alias`, and put the other IDs in `extra_aliases`. Then these addresses work in greydoc:

| HedgeDoc 1 address | greydoc |
|---|---|
| `/<id>` | Opens the editor. `?view`, `?edit` and `?both` choose the mode. |
| `/<id>/publish`, `/s/<shortid>` | View-only page. |
| `/<id>/slide`, `/p/<shortid>` | Slide mode. |
| `/<id>/download` | The Markdown text. |
| `/<id>/info` | JSON with `title`, `description`, `viewcount`, `createtime`, `updatetime`. |
| `POST /new`, `POST /new/<alias>` | Creates a document from a Markdown body and redirects to it. |

IDs are case-insensitive in greydoc. An alias with characters other than letters, digits, `-` and `_` is refused. Import such a document with its document ID instead. Very old HedgeDoc links with LZString IDs are not supported.

## The document ID

HedgeDoc 1 shows a document's UUID as base64url of its 16 bytes, without padding:

```python
import base64, uuid
def note_id(u: str) -> str:
    return base64.urlsafe_b64encode(uuid.UUID(u).bytes).decode().rstrip("=")
```

## Export

On the HedgeDoc 1 database (Postgres):

```sql
SELECT n.id, n.alias, n.shortid, n.permission, n."createdAt", n."updatedAt", n.content,
       u.email AS owner_email
FROM "Notes" n LEFT JOIN "Users" u ON u.id = n."ownerId"
WHERE n."deletedAt" IS NULL;
```

## Import

Create a personal access token in greydoc (Settings), then send each document to `POST /api/notes`. An agent can do the same with the MCP tool `create_note`, which takes the same fields.

```python
import json, urllib.request

def create(row, token, server="https://notes.example.com"):
    nid = note_id(row["id"])
    alias = row["alias"] or nid
    extra = [x for x in (nid, row["shortid"]) if x and x != alias]
    body = {
        "content": row["content"],
        "alias": alias,
        "extra_aliases": extra,
        "created_at": row["createdAt"].isoformat(),
        "updated_at": row["updatedAt"].isoformat(),
        "permissions": {"hedgedoc_mode": row["permission"]},
    }
    req = urllib.request.Request(server + "/api/notes", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))
```

Permission modes map like this. The owner always edits.

| HedgeDoc 1 mode | Anyone with the address | Signed-in users |
|---|---|---|
| `freely` | write | write |
| `editable` | read | write |
| `limited` | none | write |
| `locked` | read | read |
| `protected` | none | read |
| `private` | none | none |

"Anyone with the address" is capped by `GREYDOC_GUEST_MAX` (default write). If it is lower, `freely` documents are not editable without sign-in.

## Limits

- The imported document belongs to the user whose token runs the import.
- The document's edit history starts at the import. HedgeDoc revisions are not imported.
- `created_at` and `updated_at` keep the HedgeDoc dates until someone edits the document.

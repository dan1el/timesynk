# TimeLog

Et lokalt timeregistreringsverktøy som fungerer som master-kilde og synkroniserer timer mot **Tripletex** og **Jira**.

---

## Arkitektur

```
┌─────────────────────────────────────────┐
│            Browser (React + Vite)       │
│                TimeLog UI               │
└────────────────────┬────────────────────┘
                     │ HTTP (localhost:3001)
┌────────────────────▼────────────────────┐
│         Express backend (Node.js)       │
│              SQLite database            │
└────────┬──────────────────┬─────────────┘
         │                  │
┌────────▼──────┐   ┌───────▼──────────┐
│   Tripletex   │   │      Jira        │
│  (Playwright  │   │  (REST API v3)   │
│   + fetch)    │   │                  │
└───────────────┘   └──────────────────┘
```

---

## Flyt: Pull fra Tripletex

```mermaid
sequenceDiagram
    participant UI
    participant Backend
    participant DB as SQLite
    participant TTX as Tripletex

    UI->>Backend: POST /api/sync/pull?month=2026-04
    Backend->>TTX: Logg inn (Playwright, session cache)
    TTX-->>Backend: Session + CSRF-token
    Backend->>TTX: GET /v2/timesheet/entry?dateFrom=...&dateTo=...
    TTX-->>Backend: Timeentries (eksklusiv sluttdato)
    loop For hver entry
        Backend->>DB: Finnes Tripletex-ID allerede?
        alt Ikke funnet
            Backend->>DB: Lagre ny entry (externalIds.tripletex satt)
        end
    end
    Backend-->>UI: { pulled, skipped, month }
```

---

## Flyt: Push til Jira + Tripletex

```mermaid
sequenceDiagram
    participant UI
    participant Backend
    participant DB as SQLite
    participant TTX as Tripletex
    participant Jira

    UI->>Backend: GET /api/sync/preview?from=...&to=...
    Backend->>TTX: Hent remote entries (for stale-ID-sjekk)
    Backend->>Jira: Hent worklogs per issue (paginert, filtrert på bruker)
    Backend->>DB: Hent lokale entries

    note over Backend: Claim matching:\nJira-worklog uten lokal kobling?\nMatcher dato+timer+issue → claim (link stilletiende)

    note over Backend: Orphan-deteksjon:\nFinnes remote entry uten lokal motpart? → Slett
    note over Backend: Stale ID:\nLokal ID finnes ikke remote? → Gjenskapning

    Backend-->>UI: { toUpsert, toDelete }

    UI->>UI: Vis preview (gruppert per dag+prosjekt)
    UI->>Backend: POST /api/sync/push?from=...&to=...

    loop Claim-fase
        Backend->>DB: Skriv Jira-ID for matchede entries
    end
    loop Upsert-fase
        alt Ingen ID → opprett
            Backend->>TTX: POST /v2/timesheet/entry
            Backend->>Jira: POST /rest/api/3/issue/{key}/worklog
        else ID finnes, ikke remote → gjenskap
            Backend->>TTX: POST (ny entry)
            Backend->>Jira: POST (ny worklog)
        else Har ID, ikke synkronisert → oppdater
            Backend->>TTX: PUT /v2/timesheet/entry/{id}
        end
        Backend->>DB: Oppdater externalIds + synced_at
    end
    loop Orphan-opprydding (friske IDs)
        Backend->>TTX: DELETE /v2/timesheet/entry/{id}
        Backend->>Jira: DELETE /rest/api/3/issue/{key}/worklog/{id}
    end

    Backend-->>UI: { results }
```

---

## Datamodell

### `time_entries` (SQLite)

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `id` | TEXT (UUID) | Intern ID |
| `date` | TEXT | ISO-dato, f.eks. `2026-05-07` |
| `hours` | REAL | Timer |
| `project_id` | TEXT | Referanse til prosjekt |
| `description` | TEXT | Valgfri kommentar |
| `synced_at` | TEXT | Satt når appen selv pushet; `null` = importert fra Tripletex eller klaimed |
| `external_tripletex_id` | TEXT | Tripletex entry-ID |
| `external_jira_id` | TEXT | Sammensatt: `ISSUE-KEY:worklogId`, f.eks. `TIM-6:48213` |

### `project_mappings`

Kobler interne prosjekter til Tripletex-prosjekt/aktivitet og Jira-prosjekt/issue.

---

## Synkroniseringslogikk

### Master-kilde
Appen (SQLite) er alltid master. Pull importerer fra Tripletex, men overskriver aldri eksisterende entries.

### Claim matching
Entries importert fra Tripletex mangler Jira-ID. Når preview kjøres, sammenlignes Jira-worklogs med lokale entries på `issueKey + dato + timer`. Treff → ID skrives til DB uten å opprette duplikat.

### Stale ID-deteksjon
Dersom en lokal entry har en Tripletex- eller Jira-ID som ikke lenger finnes remote (f.eks. slettet direkte i Tripletex), gjenskapes den automatisk ved neste push.

### `syncedAt`-semantikk
- `null` → entry ble importert via pull eller claim-matching (ikke app-originert push)
- Satt → entry ble vellykket pushet av appen

---

## Datoer og tidssoner

Alle datoberegninger bruker **lokal tid** (ikke UTC) for å unngå off-by-one-feil i UTC+2. Tripletex API bruker **eksklusiv** `dateTo` – backend sender alltid første dag i neste måned som sluttdato.

---

## Teknologier

| Del | Teknologi |
|---|---|
| Frontend | React, Vite, TypeScript, TanStack Query, date-fns |
| Backend | Node.js, Express, TypeScript, better-sqlite3 |
| Tripletex-autentisering | Playwright (headless Chromium, session-cache i SQLite) |
| Jira | REST API v3, Basic Auth |
| Norske helligdager | Meeus/Jones/Butcher-algoritmen (beregnet lokalt, ingen API) |

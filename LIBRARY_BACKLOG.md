# Troubleshooting library — expansion plan

**Target: ~60 guides.** This file is the single most valuable thing in the
product. It is what a technician pays ₦4,000 for, and it is the training corpus
that makes AI diagnosis (V3) possible later.

**How we'll do this:** you dictate from memory and from real jobs. I structure
it, add the safety block, link it to parts and prices, and write it into
`data.js`. You should not have to write prose — just tell me what you'd check,
in order, and roughly what it costs.

**Rule:** if you haven't seen it on a real job, it doesn't go in yet. A library
of guesses is worse than a smaller library of truths.

---

## Done — 12 shipped

### Solar (4)
- [x] `sol-e03` — Inverter trips when a motor load starts · **E03**
- [x] `sol-lowbatt` — Low battery warning / backup time collapsed
- [x] `sol-nopv` — No solar charging / PV input reads zero
- [x] `sol-dead` — Inverter completely dead, no display

### Electrical (3)
- [x] `elec-trip` — Circuit breaker keeps tripping
- [x] `elec-smell` — Burning smell or buzzing from the DB board
- [x] `elec-dim` — Lights dim when AC or pump starts

### CCTV (2)
- [x] `cctv-black` — Camera shows no image / black screen
- [x] `cctv-norecord` — NVR not recording / playback missing

### Networking (2)
- [x] `net-wifi` — WiFi dead zones / weak signal
- [x] `net-noinet` — No internet but WiFi is connected

### Generator (1)
- [x] `gen-nooutput` — Generator starts but produces no output

---

## Next 24 — highest value first

Tick as you dictate them. I'll write each into `data.js`.

### Solar — the money trade (8 more)
- [ ] Inverter **overload alarm** / beeping continuously
- [ ] **Overvoltage / high DC bus** error on a cold morning
- [ ] Inverter **not switching to bypass** when battery is flat
- [ ] **Battery swelling** or overheating (urgent — safety critical)
- [ ] **Charge controller** not charging / showing full when it isn't
- [ ] **Panel output low** on one string only
- [ ] **Earth fault / leakage** alarm on the inverter
- [ ] **Fan noise** or inverter overheating / derating

### Electrical (6 more)
- [ ] **Socket dead** — no power at one outlet
- [ ] **RCD keeps tripping** but MCB doesn't
- [ ] **Phase loss / single-phasing** on a 3-phase supply
- [ ] **Changeover switch** not transferring to generator
- [ ] **Meter / prepaid meter** fault or "no credit" faults
- [ ] **Earthing** — high earth resistance reading

### CCTV (4 more)
- [ ] Camera **works in the day, black at night** (IR failure)
- [ ] **Foggy / water inside** the camera housing
- [ ] Remote view **stopped working** on the customer's phone
- [ ] **PTZ** not responding or drifting

### Networking (4 more)
- [ ] **Slow internet** but speed test looks fine
- [ ] **One device** can't connect (others fine)
- [ ] **Network printer / shared drive** not reachable
- [ ] **Fibre / ONT** red light or no link

### Generator (2 more)
- [ ] Generator **won't start** (cranks but no fire)
- [ ] Generator **starts then stops** after a few minutes

---

## Later — nice to have

- [ ] Air conditioning — not cooling / tripping
- [ ] Inverter battery **equalisation** procedure
- [ ] Surge / lightning damage assessment
- [ ] Water pump / borehole control faults
- [ ] Gate / electric fence faults
- [ ] Solar water heater faults

---

## What I need from you for each one

Just talk me through it. Roughly:

1. **The symptom** — what the customer says on the phone
2. **The 2–4 likely causes**, most common first
3. **What you check, in order** — the actual sequence you use
4. **The safety warning** — what must never be skipped
5. **Parts** — what you usually replace, and roughly what they cost

Five minutes of talking per guide. Don't polish it; I'll do that part.

---

## Format each entry lands in

```js
{
  id: 'sol-overload', trade: 'solar', cat: 'Hybrid inverter',
  symptom: 'Inverter overload alarm, beeping continuously',
  code: 'E05', freq: 'high',
  causes: [ { t: '...', p: 'HIGH', d: '...' } ],
  checks: [ '...', '...' ],
  safety: 'REQUIRED — no entry ships without one',
  parts: [ { d: '...', price: 0 } ],
  source: 'REHOTEQ field data'
}
```

Every entry carries a **mandatory safety block** and a **source**. The database
enforces the safety field — an entry without one cannot be saved.

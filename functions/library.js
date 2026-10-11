/* =====================================================================
   functions/library.js — Curated troubleshooting library for aiProxy

   Why this file exists: `firebase deploy --only functions` packages only
   the `functions/` directory. In local tests `../data.js` is right above
   us; in the deployed Cloud Function it is not. So we read `../data.js`
   when present and keep a synced fallback copy here, with a test in
   `tests/run.js` that fails if the two ever drift apart.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

let rootData = null;
try {
  const rootPath = path.join(__dirname, '..', 'data.js');
  if (fs.existsSync(rootPath)) {
    rootData = require(rootPath);
  }
} catch (e) {
  rootData = null;
}

const FALLBACK_LIBRARY = [
  {
    id: 'sol-e03', trade: 'solar', cat: 'Hybrid inverter', symptom: 'Inverter trips / shuts down when a motor load starts',
    code: 'E03', freq: 'high',
    causes: [
      { t: 'Loose or high-resistance DC connection', p: 'HIGH',
        d: 'Voltage collapses during the surge, tripping overcurrent protection. The most common cause on systems older than 12 months — lugs settle and loosen.' },
      { t: 'Startup surge exceeds inverter capability', p: 'MED',
        d: 'A fridge or pump compressor draws 4–6x its running current for roughly 300 ms. Compare that against the inverter surge rating, not the continuous rating.' },
      { t: 'Battery / BMS current limitation', p: 'MED',
        d: 'The BMS cuts discharge when surge current exceeds its limit. Check state of health and the BMS discharge limit against the measured surge.' }
    ],
    checks: [
      'Measure open-circuit battery voltage at the inverter terminals. On a 48 V bank expect 50–54 V.',
      'Repeat the measurement while the motor starts. A drop below about 46 V points to high resistance or a weak bank.',
      'After 10 minutes on load, feel every DC lug. A warm termination is the fault — look no further.',
      'Re-torque all DC terminations to 12 Nm (confirm against the OEM spec) and re-test.',
      'Read the inverter error log and confirm the code clears under a controlled load test.'
    ],
    safety: 'Isolate the AC supply and switch the inverter OFF before opening any panel. DC strings stay live in daylight even with the inverter off — cover the array before working on DC terminations. Do not work alone on a live system.',
    parts: [
      { d: '35 mm² copper lug', price: 1500 },
      { d: 'Heat-shrink kit', price: 1500 },
      { d: 'Torque wrench (if not carried)', price: 18000 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'sol-lowbatt', trade: 'solar', cat: 'Battery bank', symptom: 'Low battery warning / backup time has collapsed',
    code: '', freq: 'high',
    causes: [
      { t: 'Battery has aged out', p: 'HIGH',
        d: 'Tubular gel typically lasts 3–5 years in Nigerian heat; lithium 8–10. Compare measured capacity against the original commissioning figure.' },
      { t: 'One bad unit dragging the whole bank', p: 'HIGH',
        d: 'In a series string one failed unit limits everything. Measure each unit individually, not just the bank.' },
      { t: 'Undercharging from wrong charge parameters', p: 'MED',
        d: 'Wrong absorption or float voltage, or charge current set too low for the bank size.' },
      { t: 'Parasitic load left running', p: 'LOW',
        d: 'Something on the backed-up circuit that never switches off — often a decoder, router or a forgotten light.' }
    ],
    checks: [
      'Measure and log each unit voltage individually. A unit more than 0.5 V below the others is the culprit.',
      'Run a controlled discharge test to 50% DoD and log the runtime in minutes. This is the number the customer judges you on.',
      'Verify inverter charge settings: absorption, float and max charge current against the battery datasheet.',
      'List everything on the backed-up circuit and measure its standing draw.',
      'Check ambient temperature — every 10 °C above 25 °C roughly halves battery life.'
    ],
    safety: 'Batteries can deliver lethal current. Remove watches, rings and bangles. Isolate AC and DC before breaking the bank. Wear eye protection — vented batteries can emit explosive gas.',
    parts: [
      { d: 'Replacement battery unit', price: 0 },
      { d: 'Battery interconnect cable', price: 4500 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'sol-nopv', trade: 'solar', cat: 'PV array', symptom: 'No solar charging / PV input reads zero',
    code: '', freq: 'med',
    causes: [
      { t: 'DC isolator open or failed', p: 'HIGH', d: 'The single most common cause. Check it first, every time.' },
      { t: 'MC4 connector not fully seated or water ingress', p: 'HIGH', d: 'A half-clicked MC4 arcs, carbonises and fails — usually within the first rainy season.' },
      { t: 'PV polarity reversed at the inverter', p: 'MED', d: 'Shows as zero or a reverse-polarity alarm. Confirm with a meter before connecting.' },
      { t: 'Heavy shading or soiling', p: 'MED', d: 'Harmattan dust and harmattan haze can cut output by 30%+. Check the array before condemning the inverter.' },
      { t: 'Failed string / blown string fuse', p: 'LOW', d: 'Measure each string Voc and Isc separately and compare to the design values.' }
    ],
    checks: [
      'Confirm the DC isolator is ON and not faulty — test across it, do not trust the knob.',
      'Measure string Voc in full sun and compare against the design figure. Zero means an open circuit; roughly half means a bypassed or failed panel.',
      'Measure string Isc. Compare against the datasheet at current irradiance.',
      'Inspect every MC4 for full seating, cracks and water ingress. Replace any that are brown or melted.',
      'Check for shading and clean the array before concluding anything is broken.'
    ],
    safety: 'PV strings produce lethal DC voltage whenever there is daylight — there is no off switch. Isolate at the DC isolator and cover panels with an opaque material before touching terminations. Never break an MC4 under load.',
    parts: [
      { d: 'MC4 connector pair', price: 1200 },
      { d: 'DC isolator', price: 8500 },
      { d: 'String fuse', price: 900 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'sol-dead', trade: 'solar', cat: 'Hybrid inverter', symptom: 'Inverter completely dead — no display, no output',
    code: '', freq: 'med',
    causes: [
      { t: 'Battery deeply discharged below cut-off', p: 'HIGH', d: 'Most likely. Without a battery the inverter has nothing to boot from, even with good solar.' },
      { t: 'Reverse polarity damage', p: 'MED', d: 'If the battery was ever connected backwards the input stage is usually destroyed.' },
      { t: 'Internal fuse blown', p: 'MED', d: 'Often from a surge or lightning strike nearby.' },
      { t: 'Lightning / surge damage', p: 'MED', d: 'Very common in Nigeria. Check whether the earthing and SPDs are intact too.' }
    ],
    checks: [
      'Measure battery voltage at the inverter terminals. Below the inverter cut-off (often ~40 V on a 48 V system) it will not start.',
      'Check the DC input fuse and any inline breaker.',
      'Confirm polarity at the terminals — positive to positive.',
      'With AC mains present only, does it boot? If yes, the problem is the battery side.',
      'Inspect for surge damage: burn marks, bulged capacitors, blown MOV. Check the SPD and earth at the same time.'
    ],
    safety: 'Isolate AC and DC before opening. Internal capacitors can hold a lethal charge for several minutes after isolation — wait and discharge safely. If the unit shows burn marks, do not re-energise it.',
    parts: [
      { d: 'DC fuse', price: 1500 },
      { d: 'Surge protection device (SPD)', price: 12000 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'elec-trip', trade: 'electrical', cat: 'Protective devices', symptom: 'Circuit breaker keeps tripping',
    code: '', freq: 'high',
    causes: [
      { t: 'Genuine overload', p: 'HIGH', d: 'Too many appliances on one circuit. Add up the loading and compare against the breaker rating.' },
      { t: 'Earth fault / leakage', p: 'HIGH', d: 'If an RCD or RCBO trips, it is leakage, not overload — the two look identical to a customer.' },
      { t: 'Loose termination overheating the breaker', p: 'MED', d: 'A loose lug heats the breaker until it trips on thermal protection, then resets when cool.' },
      { t: 'Failing breaker', p: 'LOW', d: 'Breakers wear out. If it trips with almost no load, suspect the device.' },
      { t: 'Damp in an accessory or junction box', p: 'MED', d: 'Very common in the rainy season. Check outdoor and bathroom circuits first.' }
    ],
    checks: [
      'Ask what is running when it trips, and how soon after reset. Instant = short circuit or leakage. After minutes = overload.',
      'Isolate and measure insulation resistance on the circuit. Expect above 1 MΩ.',
      'If it is an RCD, split the circuit and test each part separately to find the leaking leg.',
      'Open the DB and feel for warmth, look for discoloration. Torque-check the terminations.',
      'Inspect outdoor boxes and accessories for moisture ingress.'
    ],
    safety: 'Isolate and prove dead before opening the board. Test your tester on a known live source first, then on the circuit, then back on the known source. Never bridge or uprate a breaker to "stop it tripping" — this is how buildings burn.',
    parts: [
      { d: 'RCBO', price: 9500 },
      { d: 'Weatherproof junction box', price: 2500 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'elec-smell', trade: 'electrical', cat: 'DB board', symptom: 'Burning smell or buzzing from the DB board',
    code: '', freq: 'high',
    causes: [
      { t: 'Loose termination arcing', p: 'HIGH', d: 'The classic. Loose conductors arc, carbonise and heat until something melts.' },
      { t: 'Undersized cable for the protective device', p: 'HIGH', d: 'Cable sized below the breaker rating will overheat before the breaker trips.' },
      { t: 'Overloaded neutral or shared neutral', p: 'MED', d: 'Common in older Nigerian installations where neutrals were shared between circuits.' },
      { t: 'Damaged or undersized main isolator', p: 'MED', d: 'Check the incoming termination — the highest-current joint in the building.' }
    ],
    checks: [
      'Isolate immediately and do not re-energise until you have found the cause.',
      'Remove the cover and look for discolouration, melted insulation or carbon tracking. Photograph everything before touching it.',
      'Torque-check every termination in the board.',
      'Confirm cable size against the protective device rating on each circuit.',
      'Check the incoming supply termination and the main isolator.',
      'Thermal scan under load after repair if you have the tool.'
    ],
    safety: 'TREAT AS AN EMERGENCY. Isolate the supply at the main switch before opening the board. Do not re-energise until the cause is found and fixed. If the customer reports sparks or smoke, evacuate the area and call the fire service first.',
    parts: [
      { d: 'Main isolator', price: 15000 },
      { d: 'Cable (per metre)', price: 1800 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'elec-dim', trade: 'electrical', cat: 'Supply', symptom: 'Lights dim when the AC or water pump starts',
    code: '', freq: 'med',
    causes: [
      { t: 'Undersized cable on the sub-main', p: 'HIGH', d: 'Voltage drop on starting current. Check the cable run length against its cross-section.' },
      { t: 'Loose or corroded neutral', p: 'HIGH', d: 'A poor neutral causes voltage to swing wildly between legs — this can destroy appliances.' },
      { t: 'Weak incoming supply / small transformer', p: 'MED', d: 'Measure at the meter, not inside. If the incoming supply sags, it is the utility, not the house.' },
      { t: 'No soft starter on the motor', p: 'MED', d: 'A pump or large AC without a soft starter will always cause a visible dip.' }
    ],
    checks: [
      'Measure voltage at the meter with the motor off, then while it starts. If the meter sags too, the problem is upstream.',
      'If the meter holds but the house sags, the problem is the sub-main — check cable size and run length.',
      'Inspect and torque the neutral terminations at the meter and the DB.',
      'Check the earth-neutral bond integrity.',
      'Recommend a soft starter or a dedicated circuit for the motor load.'
    ],
    safety: 'Isolate before working on the meter or DB. A floating or broken neutral can put full phase voltage across equipment — if the customer reports appliances blowing, treat it as urgent and check the neutral first.',
    parts: [
      { d: 'Soft starter', price: 45000 },
      { d: 'Contactor', price: 12000 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'cctv-black', trade: 'cctv', cat: 'Camera', symptom: 'Camera shows no image / black screen',
    code: '', freq: 'high',
    causes: [
      { t: 'Power supply failed or voltage drop', p: 'HIGH', d: 'Measure at the camera end, not at the PSU. Long runs drop 12 V below what the camera needs.' },
      { t: 'Water ingress in the connector', p: 'HIGH', d: 'The single most common cause after the first rainy season. Check every outdoor joint.' },
      { t: 'Faulty camera', p: 'MED', d: 'Swap-test with a known-good camera to confirm before replacing.' },
      { t: 'Wrong cable or termination', p: 'MED', d: 'Check whether it is BNC or RJ45 and whether it is terminated to the right standard.' },
      { t: 'NVR channel not enabled or wrong protocol', p: 'LOW', d: 'An IP camera on the wrong ONVIF profile will connect but show nothing.' }
    ],
    checks: [
      'Measure voltage at the camera end of the run under load. Below ~11 V on a 12 V camera is a problem.',
      'Inspect the connectors for green corrosion or water. Redo any that are suspect with self-amalgamating tape.',
      'Swap in a known-good camera at the same point. If the picture returns, the camera is faulty.',
      'Check the port and channel configuration on the NVR.',
      'Confirm the camera is actually powered — IR LEDs glow faintly in the dark even with no video.'
    ],
    safety: 'Use a stable ladder and never work on a ladder in the rain or wind. Isolate the PSU before re-terminating. Get a second person for anything above head height.',
    parts: [
      { d: '12 V camera PSU', price: 6500 },
      { d: 'Self-amalgamating tape', price: 2500 },
      { d: 'RJ45 connector (pack)', price: 1500 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'cctv-norecord', trade: 'cctv', cat: 'NVR / DVR', symptom: 'NVR not recording / playback missing',
    code: '', freq: 'high',
    causes: [
      { t: 'HDD failed or not initialised', p: 'HIGH', d: 'The usual cause. Check the HDD status in the NVR menu — "no disk" or "uninitialised" tells you immediately.' },
      { t: 'Recording schedule not configured', p: 'HIGH', d: 'Very common after a power cut resets the NVR to defaults.' },
      { t: 'HDD full with overwrite disabled', p: 'MED', d: 'The drive quietly stops when it fills up.' },
      { t: 'NVR time/date wrong', p: 'MED', d: 'Footage exists but the customer is looking at the wrong date on the timeline.' },
      { t: 'Motion detection set too insensitive', p: 'LOW', d: 'Looks like nothing was recorded when the camera simply never triggered.' }
    ],
    checks: [
      'Check HDD status and free space in the NVR storage menu.',
      'Check the recording schedule — set continuous or motion, per camera.',
      'Verify overwrite is enabled.',
      'Correct the NVR date and time and then search the correct date on the timeline.',
      'Pull a clip for the customer to prove recording works before you leave.'
    ],
    safety: 'Isolate the NVR before opening the case or swapping the drive. Back up any footage the customer needs before touching the HDD — you cannot recover it afterwards.',
    parts: [
      { d: 'Surveillance HDD 4 TB', price: 85000 },
      { d: 'SATA cable', price: 1500 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'net-wifi', trade: 'networking', cat: 'WiFi', symptom: 'WiFi dead zones / weak signal in parts of the building',
    code: '', freq: 'high',
    causes: [
      { t: 'AP poorly sited', p: 'HIGH', d: 'In a cupboard, behind a TV, or on the floor. Height and line of sight matter more than power.' },
      { t: 'Channel congestion from neighbouring APs', p: 'HIGH', d: 'In dense areas every AP defaults to the same channels. 2.4 GHz is usually the worst.' },
      { t: 'Thick walls / reinforced concrete', p: 'MED', d: 'Nigerian blockwork and burglar bars both attenuate heavily. Bars on windows kill signal.' },
      { t: 'Single AP trying to cover too much', p: 'MED', d: 'One router cannot cover a large house. Add an AP or mesh node.' }
    ],
    checks: [
      'Walk the site with a WiFi analyser and log dBm in every room. Above about -70 dBm is unusable for real work.',
      'Scan for neighbouring networks and pick the least-congested channel (1, 6 or 11 on 2.4 GHz).',
      'Test ISP speed over a cable at the router — this is the ceiling WiFi cannot beat.',
      'Relocate the AP: high, central, away from metal and microwaves.',
      'Add an AP or mesh node where the survey showed gaps, then re-survey every dead zone.'
    ],
    safety: 'Use a proper ladder for AP mounting. Never run data cable alongside mains in the same conduit — it is both a safety and a performance issue.',
    parts: [
      { d: 'Access point', price: 55000 },
      { d: 'Mesh node', price: 42000 },
      { d: 'Cat6 cable (per metre)', price: 850 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'net-noinet', trade: 'networking', cat: 'Router / WAN', symptom: 'No internet but WiFi is connected',
    code: '', freq: 'high',
    causes: [
      { t: 'ISP outage or unpaid subscription', p: 'HIGH', d: 'Rule this out first — it costs nothing and is right more often than anything else.' },
      { t: 'Router needs a restart / hung session', p: 'HIGH', d: 'Power-cycle and wait a full two minutes before testing.' },
      { t: 'WAN cable or fibre fault', p: 'MED', d: 'Check the link light on the WAN port and the ONT.' },
      { t: 'Wrong PPPoE credentials after a router reset', p: 'MED', d: 'A power surge resets the router and the credentials go with it.' },
      { t: 'DNS failure', p: 'LOW', d: 'Pages fail but pings to an IP address work. Point DNS at 1.1.1.1 or 8.8.8.8 to confirm.' }
    ],
    checks: [
      'Test with a phone on mobile data — is the whole building down or one device?',
      'Check the router WAN link light and the ISP ONT status lights.',
      'Power-cycle the router and wait two full minutes.',
      'Ping 8.8.8.8. If that works but browsing fails, it is DNS.',
      'Log into the router and check the WAN status — no IP means an authentication or ISP-side problem.',
      'Call the ISP with the account number and the ONT readings in hand.'
    ],
    safety: 'Do not open the ISP ONT — that is their equipment and it is often live fibre. Never look directly into a fibre connector; fibre light is invisible and can damage the eye.',
    parts: [
      { d: 'Patch cable', price: 1500 },
      { d: 'Router', price: 45000 }
    ],
    source: 'REHOTEQ field data'
  },
  {
    id: 'gen-nooutput', trade: 'electrical', cat: 'Generator', symptom: 'Generator starts but produces no output',
    code: '', freq: 'med',
    causes: [
      { t: 'Residual magnetism lost in the alternator', p: 'HIGH', d: 'Common after long storage. Needs field flashing — a five-minute job that looks like a dead generator.' },
      { t: 'AVR faulty', p: 'HIGH', d: 'Automatic voltage regulator failure gives zero or wildly unstable output.' },
      { t: 'Circuit breaker tripped on the set', p: 'MED', d: 'Check the output breaker on the set itself, not just the changeover.' },
      { t: 'Engine speed too low', p: 'MED', d: 'Wrong frequency means wrong voltage. Check the governor and theHz reading.' },
      { t: 'Brushes worn (on brushed sets)', p: 'LOW', d: 'Inspect and replace if below the wear mark.' }
    ],
    checks: [
      'Check the output breaker and any RCD on the set.',
      'Measure output voltage and frequency — 50 Hz and roughly 230 V phase-to-neutral.',
      'If voltage is zero but the engine runs at speed, flash the field (follow the OEM procedure exactly).',
      'If voltage is present but unstable or wildly high, suspect the AVR.',
      'Inspect brushes and slip rings where applicable.',
      'Test under load, not just open circuit.'
    ],
    safety: 'Never run a generator indoors or in an enclosed space — carbon monoxide kills in minutes. Never back-feed the building without a proper changeover switch; you can kill a linesman working on the supply. Isolate before opening the alternator cover.',
    parts: [
      { d: 'AVR', price: 35000 },
      { d: 'Brush set', price: 8000 }
    ],
    source: 'REHOTEQ field data'
  }
];

module.exports = {
  LIBRARY: (rootData && Array.isArray(rootData.LIBRARY)) ? rootData.LIBRARY : FALLBACK_LIBRARY,
  FALLBACK_LIBRARY: FALLBACK_LIBRARY
};

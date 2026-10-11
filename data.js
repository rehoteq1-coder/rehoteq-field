/* =====================================================================
   data.js — trades, checklists and the curated troubleshooting library

   This file IS the product in V1. Not the code — this.
   Everything here should come from real REHOTEQ jobs. Anything you
   haven't actually seen on a job should not be in here yet.
   ===================================================================== */
(function (global) {
  'use strict';

  const TRADES = [
    { id: 'electrical',  icon: 'zap',         name: 'Electrical',       desc: 'Wiring · inverter · DB' },
    { id: 'solar',       icon: 'solar-panel', name: 'Solar',            desc: 'PV · battery · hybrid' },
    { id: 'cctv',        icon: 'cctv',        name: 'CCTV',             desc: 'Install · service · NVR' },
    { id: 'networking',  icon: 'router',      name: 'Networking',      desc: 'LAN · WiFi · fibre' },
    { id: 'hvac',        icon: 'snowflake',   name: 'HVAC',             desc: 'Air conditioning · ventilation' },
    { id: 'generator',   icon: 'gauge',       name: 'Generator',        desc: 'Standby power · changeover' },
    { id: 'plumbing',    icon: 'droplets',    name: 'Plumbing',         desc: 'Water · drainage · pumps' },
    { id: 'fire_access', icon: 'flame',       name: 'Fire & Access',    desc: 'Fire alarm · access control' },
    { id: 'smarthome',   icon: 'cpu',         name: 'Smart Home',       desc: 'Automation · controls · IoT' },
    { id: 'ev',           icon: 'plug-zap',    name: 'EV Charging',      desc: 'EV charger · protection · test' }
  ];

  const JOB_TYPES = {
    electrical: ['Fault diagnosis', 'New wiring / rewiring', 'DB board work',
                 'Generator changeover', 'Appliance repair'],
    solar:      ['Inverter fault diagnosis', 'New solar installation', 'Battery replacement',
                 'Maintenance / service', 'Panel cleaning & inspection'],
    cctv:       ['New CCTV installation', 'CCTV service / repair', 'NVR / DVR fault',
                 'Camera replacement', 'CCTV commissioning & handover'],
    networking: ['New network install', 'WiFi dead zones', 'Fibre termination',
                 'Router / switch fault', 'Structured cabling & certification'],
    hvac:       ['AC fault diagnosis', 'Split AC installation', 'HVAC preventive maintenance',
                 'Refrigerant leak inspection', 'Ventilation / exhaust fan service'],
    generator:  ['Generator fault diagnosis', 'Generator installation', 'Generator servicing',
                 'ATS / changeover commissioning', 'Load bank test'],
    plumbing:   ['Leak repair', 'Water pump installation', 'Drain blockage / clearing',
                 'Water heater service', 'Pipework installation'],
    fire_access:['Fire alarm / sprinkler maintenance', 'Fire alarm fault diagnosis', 'Access control installation',
                 'Emergency lighting test', 'Door entry / intercom repair'],
    smarthome:  ['Smart home commissioning', 'Lighting automation fault', 'Smart thermostat installation',
                 'Home network / hub setup', 'Sensor and scene configuration'],
    ev:         ['EV charger installation', 'EV charger fault diagnosis', 'EV charger inspection & test',
                 'Load management setup', 'Charging point replacement']
  };

  /* -------------------------------------------------------------------
     CHECKLISTS — v1. Edit freely; these are REHOTEQ's own standards.
     critical: true  → job cannot be completed until it passes
     photo:    true  → app asks for a photo before you can tick it
     ------------------------------------------------------------------- */
  const CHECKLISTS = {
    'solar|Inverter fault diagnosis': {
      name: 'Inverter fault diagnosis', version: 1, items: [
        { l: 'Isolate AC supply and lock off before opening', h: 'Safety first', critical: true },
        { l: 'Record inverter model, firmware and error log', h: 'Photo the nameplate', photo: true },
        { l: 'Measure open-circuit battery voltage at inverter terminals', h: '48 V bank: expect 50–54 V' },
        { l: 'Measure voltage again under surge load', h: 'Drop below ~46 V means resistance or weak bank' },
        { l: 'Inspect and feel DC terminations for heat damage', h: 'Warm lug = high resistance', photo: true },
        { l: 'Torque-check all DC connections', h: 'Typically 12 Nm — check OEM spec' },
        { l: 'Check battery state of health / BMS readout', h: 'Note SoH % and any cell imbalance' },
        { l: 'Verify inverter surge rating vs actual starting current', h: 'Fridge/pump draw 4–6x running current' },
        { l: 'Earth bond continuity check', h: 'Expect < 0.5 Ω' },
        { l: 'Load test on site and confirm the fault code clears', h: 'Minimum 15 minutes', critical: true },
        { l: 'Customer handover and sign-off', h: 'Explain findings in plain language', critical: true }
      ]
    },
    'solar|New solar installation': {
      name: 'New solar installation', version: 1, items: [
        { l: 'Site survey: roof condition, shading, orientation', h: 'Photo the roof before starting', photo: true, critical: true },
        { l: 'Confirm structural fixing points and load path' },
        { l: 'Mount rails, torque to spec', h: 'Photo before panels go on', photo: true },
        { l: 'Panel layout and clamping', h: 'Record serial numbers of every panel', photo: true },
        { l: 'MC4 termination and cable routing', h: 'No cable resting on the roof surface' },
        { l: 'DC isolator installed and labelled', h: 'Within reach of the inverter' },
        { l: 'Battery installation and venting', h: 'Record battery serial numbers', photo: true, critical: true },
        { l: 'Inverter mounting and AC connection via isolator' },
        { l: 'Earthing: array frame + inverter + DB', h: 'Measure and record earth resistance', critical: true },
        { l: 'Measure string Voc and Isc before energising', h: 'Compare against design values' },
        { l: 'Commissioning: configure inverter, set charge parameters' },
        { l: 'Load test at design load', h: 'Minimum 30 minutes', critical: true },
        { l: 'Thermal scan of all terminations under load', h: 'Photo the readings', photo: true },
        { l: 'Label everything: isolators, DB, cable runs' },
        { l: 'Issue solar passport QR and stick to DB board', h: 'Customer scans — no app needed', critical: true },
        { l: 'Customer handover: walkthrough, warranty, sign-off', h: 'Explain what not to plug in', critical: true }
      ]
    },
    'solar|Battery replacement': {
      name: 'Battery replacement', version: 1, items: [
        { l: 'Isolate AC and DC, confirm zero voltage', h: 'Test before you touch', critical: true },
        { l: 'Photo the existing bank and its wiring before removal', photo: true, critical: true },
        { l: 'Record old battery serial numbers and SoH', photo: true },
        { l: 'Confirm replacement chemistry matches inverter profile', h: 'Lithium vs gel charge profiles differ' },
        { l: 'Check BMS communication cable and polarity', h: 'Wrong polarity destroys the BMS', critical: true },
        { l: 'Torque all interconnects to spec' },
        { l: 'Update inverter battery settings (capacity, DoD, charge current)' },
        { l: 'Charge to full and log voltage per unit' },
        { l: 'Discharge test to 50% DoH, log runtime', h: 'This is the number the customer will judge you on', critical: true },
        { l: 'Confirm no error codes under load', critical: true },
        { l: 'Dispose of old batteries responsibly', h: 'Never in general waste' },
        { l: 'Customer handover and sign-off', critical: true }
      ]
    },
    'solar|Maintenance / service': {
      name: 'Solar maintenance / service', version: 1, items: [
        { l: 'Isolate AC supply and lock off', critical: true },
        { l: 'Visual inspection of panels: cracks, soiling, shading', photo: true },
        { l: 'Clean panels if soiled', h: 'Early morning or late evening only' },
        { l: 'Inspect and torque all DC terminations', photo: true },
        { l: 'Check inverter cooling fans and ventilation' },
        { l: 'Read and clear inverter error log' },
        { l: 'Measure battery voltage and SoH', h: 'Record for trend comparison' },
        { l: 'Verify earth bond continuity', h: '< 0.5 Ω' },
        { l: 'Load test the system', critical: true },
        { l: 'Update maintenance record / passport', h: 'Sets the next reminder' },
        { l: 'Customer handover and sign-off', critical: true }
      ]
    },
    'electrical|Fault diagnosis': {
      name: 'Electrical fault diagnosis', version: 1, items: [
        { l: 'Isolate the circuit and prove dead', h: 'Test the tester first', critical: true },
        { l: 'Identify circuit on the DB schedule', h: 'Photo the DB before and after', photo: true },
        { l: 'Insulation resistance test', h: 'Expect > 1 MΩ' },
        { l: 'Earth fault loop impedance test', h: 'Compare against BS 7671 limits for the protective device' },
        { l: 'Inspect accessories on the circuit', photo: true },
        { l: 'Check terminations for looseness or heat damage', photo: true },
        { l: 'Confirm protective device rating vs cable size', critical: true },
        { l: 'Re-energise and test under load', h: 'Minimum 10 minutes', critical: true },
        { l: 'Customer handover and sign-off', critical: true }
      ]
    },
    'electrical|DB board work': {
      name: 'DB board work', version: 1, items: [
        { l: 'Isolate supply at the main switch and lock off', critical: true },
        { l: 'Prove dead on every way, including the incoming', critical: true },
        { l: 'Photo the existing board and schedule before work', photo: true, critical: true },
        { l: 'Confirm supply type: TN-S / TN-C-S / TT' },
        { l: 'Verify main earth and bonding are present and sized' },
        { l: 'Terminate all conductors to torque spec' },
        { l: 'Label every way to match the schedule', photo: true },
        { l: 'RCD test on every RCD-protected circuit', critical: true },
        { l: 'Insulation resistance test whole-board', h: '> 1 MΩ' },
        { l: 'Photo the finished board', photo: true, critical: true },
        { l: 'Customer handover: walk the schedule with them', critical: true }
      ]
    },
    'cctv|New CCTV installation': {
      name: 'New CCTV installation', version: 1, items: [
        { l: 'Walk the site and agree camera positions with customer', photo: true, critical: true },
        { l: 'Check coverage blind spots at each position' },
        { l: 'Cable route agreed and safe from weather', photo: true },
        { l: 'Mount cameras, level and secure', photo: true },
        { l: 'Terminate: BNC or RJ45, and power at each end', photo: true },
        { l: 'NVR sited, ventilated and secured', critical: true },
        { l: 'Network config: static IPs, no conflicts' },
        { l: 'Set recording schedule and retention', h: 'Confirm retention days with customer' },
        { l: 'Enable motion detection and alerts' },
        { l: 'Remote view configured on customer phone', h: 'Test it in front of them', critical: true },
        { l: 'Record camera and NVR serial numbers', photo: true, critical: true },
        { l: 'Two-week playback test confirmed with customer', h: 'Book a return visit to verify' },
        { l: 'Customer handover and sign-off', critical: true }
      ]
    },
    'cctv|CCTV service / repair': {
      name: 'CCTV service / repair', version: 1, items: [
        { l: 'Confirm which channels are faulty and since when' },
        { l: 'Photo the fault on screen as found', photo: true, critical: true },
        { l: 'Check power supply voltage at the camera end', h: 'Voltage drop is the usual suspect' },
        { l: 'Test the cable run end to end' },
        { l: 'Swap-test with a known-good camera to isolate the fault' },
        { l: 'Check NVR port and channel config' },
        { l: 'Clean lenses and housings', photo: true },
        { l: 'Confirm recording is actually happening', h: 'Check the timeline, not just live view', critical: true },
        { l: 'Confirm remote view still works on customer phone', critical: true },
        { l: 'Customer handover and sign-off', critical: true }
      ]
    },
    'networking|New network install': {
      name: 'New network install', version: 1, items: [
        { l: 'Survey: floor plan, wall materials, interference sources', photo: true },
        { l: 'Confirm ISP handover point and required throughput' },
        { l: 'Cable routes agreed and labelled both ends', photo: true },
        { l: 'Terminate to T568B and test every run', h: 'Certify with a tester where possible', critical: true },
        { l: 'Patch panel dressed and labelled', photo: true },
        { l: 'Switch, router and AP placement and grounding' },
        { l: 'Configure VLANs / SSIDs and passwords' },
        { l: 'Survey WiFi with a signal app at every usable point', photo: true, critical: true },
        { l: 'Throughput test at the furthest point', critical: true },
        { l: 'Document: IP plan, passwords, topology', h: 'Hand this over — it is part of the job', critical: true },
        { l: 'Customer handover and sign-off', critical: true }
      ]
    },
    'networking|WiFi dead zones': {
      name: 'WiFi dead zones', version: 1, items: [
        { l: 'Walk the site with a signal app, log dBm per room', photo: true, critical: true },
        { l: 'Identify channel congestion from neighbouring APs' },
        { l: 'Confirm ISP speed at the router, not over WiFi', h: 'Establishes the ceiling' },
        { l: 'Check AP/router placement and antenna orientation' },
        { l: 'Separate 2.4 GHz and 5 GHz SSIDs or enable band steering' },
        { l: 'Select least-congested channels' },
        { l: 'Add AP or mesh node where survey showed gaps' },
        { l: 'Re-survey every dead zone after changes', photo: true, critical: true },
        { l: 'Throughput test at the furthest point', critical: true },
        { l: 'Customer handover and sign-off', critical: true }
      ]
    },
    'hvac|AC fault diagnosis': {
      name: 'AC fault diagnosis', version: 1, items: [
        { l: 'Confirm reported symptoms, operating mode and set point' },
        { l: 'Isolate the indoor and outdoor units and prove dead before opening', critical: true },
        { l: 'Allow capacitors to discharge and verify before touching terminals', critical: true },
        { l: 'Record model, serial number and displayed fault code', photo: true },
        { l: 'Inspect filters, coil cleanliness, airflow and fan operation' },
        { l: 'Inspect condensate tray and drain for blockage or overflow' },
        { l: 'Check terminals, cable condition and protective device rating', photo: true },
        { l: 'Record supply voltage and return / supply air temperatures' },
        { l: 'Do not vent refrigerant; refer sealed-system work to a qualified handler', critical: true },
        { l: 'Restore guards, run a monitored test and explain findings to customer', critical: true }
      ]
    },
    'generator|Generator fault diagnosis': {
      name: 'Generator fault diagnosis', version: 1, items: [
        { l: 'Confirm symptoms, alarm history and when the fault occurs' },
        { l: 'Verify the set is outdoors with exhaust clear of doors and windows', critical: true },
        { l: 'Isolate generator and utility sources before opening the ATS or terminals', critical: true },
        { l: 'Prove dead and prevent any possibility of back-feed', critical: true },
        { l: 'Record engine, alternator and controller model / serial', photo: true },
        { l: 'Check fuel, oil, coolant and visible leaks with the set stopped' },
        { l: 'Inspect battery connections and charger with insulated tools' },
        { l: 'Record output voltage and frequency only with suitable rated instruments' },
        { l: 'Run a controlled load test and confirm alarms clear', critical: true },
        { l: 'Return ATS to the agreed mode and hand over the test record', critical: true }
      ]
    },
    'plumbing|Leak repair': {
      name: 'Leak repair', version: 1, items: [
        { l: 'Confirm leak location, source and any water damage' },
        { l: 'Isolate the water supply and relieve pressure before cutting pipe', critical: true },
        { l: 'Isolate nearby electrical equipment if there is any water ingress', critical: true },
        { l: 'Cool and depressurise hot-water pipework before opening it', critical: true },
        { l: 'Photograph the pipe, fittings and leak before repair', photo: true },
        { l: 'Identify pipe material, size and compatible joining method' },
        { l: 'Replace damaged section and support pipework correctly' },
        { l: 'Restore supply gradually and inspect every joint under pressure', critical: true },
        { l: 'Check adjacent surfaces and electrical areas are dry and safe', critical: true },
        { l: 'Explain repair, isolation point and any follow-up to customer', critical: true }
      ]
    },
    'fire_access|Fire alarm / sprinkler maintenance': {
      name: 'Fire alarm / sprinkler maintenance', version: 1, items: [
        { l: 'Notify site contact and monitoring station before testing', critical: true },
        { l: 'Record the impairment permit, affected zones and fire-watch plan', critical: true },
        { l: 'Keep life-safety systems enabled except for the permitted test window', critical: true },
        { l: 'Inspect panel status, power supplies, batteries and fault log', photo: true },
        { l: 'Test devices and circuits using the manufacturer procedure' },
        { l: 'Inspect accessible sprinkler valves, gauges and tamper switches' },
        { l: 'Record every failed device, zone and corrective action', photo: true },
        { l: 'Restore all bypasses, valves and zones to normal service', critical: true },
        { l: 'Confirm normal status at panel and monitoring station', critical: true },
        { l: 'Close the impairment permit and hand over the test log', critical: true }
      ]
    },
    'smarthome|Smart home commissioning': {
      name: 'Smart home commissioning', version: 1, items: [
        { l: 'Confirm device list, scenes and acceptance criteria with customer' },
        { l: 'Isolate mains circuits and prove dead before wiring control modules', critical: true },
        { l: 'Keep extra-low-voltage wiring separated from mains as required' },
        { l: 'Record hub, controller and device model / firmware versions', photo: true },
        { l: 'Label circuits, relays and control points clearly' },
        { l: 'Pair devices and verify signal strength at installed locations' },
        { l: 'Test each scene, sensor trigger and manual override' },
        { l: 'Set up customer-owned accounts and hand over credentials securely', critical: true },
        { l: 'Confirm core lighting / access functions work without cloud service' },
        { l: 'Demonstrate operation and obtain customer sign-off', critical: true }
      ]
    },
    'ev|EV charger installation': {
      name: 'EV charger installation', version: 1, items: [
        { l: 'Confirm charger rating, vehicle connector and installation location' },
        { l: 'Complete supply capacity and route survey before installation', critical: true },
        { l: 'Isolate, lock off and prove dead at the point of connection', critical: true },
        { l: 'Verify protective device and DC residual-current protection against OEM / local rules', critical: true },
        { l: 'Check earthing arrangement and bonding suitability', critical: true },
        { l: 'Mount charger securely and protect the cable route from damage' },
        { l: 'Record charger model, serial number and configuration', photo: true },
        { l: 'Test polarity, protective conductor and required RCD operation', critical: true },
        { l: 'Commission with manufacturer procedure and a controlled charge test', critical: true },
        { l: 'Label isolator and hand over emergency shutdown instructions', critical: true }
      ]
    }
  };

  /* -------------------------------------------------------------------
     TROUBLESHOOTING LIBRARY
     Deterministic. Offline. Authored from real jobs — never generated.
     safety is a required field: no entry ships without one.
     ------------------------------------------------------------------- */
  const LIBRARY = [
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
        { t: 'Circuit breaker tripped on the set', p: 'MED', d: 'Check the output breaker on the generator itself, not just the changeover.' },
        { t: 'Engine speed too low', p: 'MED', d: 'Wrong frequency means wrong voltage. Check the governor and the Hz reading.' },
        { t: 'Brushes worn (on brushed sets)', p: 'LOW', d: 'Inspect and replace if below the wear mark.' }
      ],
      checks: [
        'Check the output breaker and any RCD on the set.',
        'Measure output voltage and frequency — confirm the rating plate and local supply standard.',
        'If voltage is zero but the engine runs at speed, stop and follow the OEM excitation test procedure.',
        'If voltage is unstable or unusually high, stop the set and inspect the AVR circuit.',
        'Inspect brushes and slip rings only after isolation and proving dead.',
        'Test under a controlled load after all covers and guards are restored.'
      ],
      safety: 'Never run a generator indoors or in an enclosed space — carbon monoxide can kill without warning. Prevent automatic start, isolate generator and utility sources, and prove dead before opening the alternator cover. Never back-feed without an approved changeover system.',
      parts: [
        { d: 'AVR (confirm model first)', price: 35000 },
        { d: 'Brush set (where fitted)', price: 8000 }
      ],
      source: 'REHOTEQ field data'
    },
    {
      id: 'hvac-nocool', trade: 'hvac', cat: 'Split air conditioner', symptom: 'Air conditioner runs but room does not cool',
      code: '', freq: 'high',
      causes: [
        { t: 'Restricted filter or dirty indoor coil', p: 'HIGH', d: 'Reduced airflow is a common cause and can make the unit appear undercharged.' },
        { t: 'Incorrect mode or set point', p: 'HIGH', d: 'Confirm cooling mode, fan setting, doors and windows before opening equipment.' },
        { t: 'Outdoor fan or condenser airflow problem', p: 'MED', d: 'Blocked discharge or a stopped fan can cause poor cooling and protective shutdown.' },
        { t: 'Electrical supply or capacitor fault', p: 'MED', d: 'A weak supply or failed component may prevent the compressor starting.' },
        { t: 'Refrigerant circuit leak or restriction', p: 'MED', d: 'Requires qualified leak diagnosis and refrigerant recovery; do not top up by guesswork.' }
      ],
      checks: [
        'Confirm cooling mode, set point and indoor fan setting with the customer.',
        'Inspect and clean the filter using the manufacturer instructions; confirm airflow improves.',
        'Check that the outdoor unit has clear airflow and that the fan runs when called.',
        'Record model, displayed fault code, supply readings and return / supply air temperatures.',
        'Isolate and prove dead before opening electrical covers; allow capacitors to discharge.',
        'If refrigerant work is indicated, stop and use a qualified handler with recovery equipment.'
      ],
      safety: 'ISOLATE AC power at the correct disconnect, lock off and prove dead before opening either unit. Capacitors can retain a dangerous charge after isolation. Do not release refrigerant or open the sealed system unless qualified and equipped for recovery.',
      parts: [
        { d: 'Replacement filter (confirm model)', price: 8500 },
        { d: 'Run capacitor (confirm rating)', price: 12000 }
      ],
      source: 'REHOTEQ field data'
    },
    {
      id: 'gen-nostart', trade: 'generator', cat: 'Standby generator', symptom: 'Generator cranks but does not start',
      code: '', freq: 'high',
      causes: [
        { t: 'Fuel supply closed, low or contaminated', p: 'HIGH', d: 'Check the gauge, isolation valve and visible fuel condition without opening a hot fuel system.' },
        { t: 'Battery weak or connections corroded', p: 'HIGH', d: 'Cranking voltage may collapse even when the starter turns.' },
        { t: 'Emergency stop or controller inhibit active', p: 'MED', d: 'A latched stop, alarm or start-permissive can prevent ignition.' },
        { t: 'Air filter or intake restricted', p: 'MED', d: 'A blocked intake can prevent reliable starting under load or in dusty conditions.' },
        { t: 'Starter, solenoid or engine fault', p: 'LOW', d: 'Mechanical or control faults need model-specific diagnosis.' }
      ],
      checks: [
        'Confirm the site is outdoors and exhaust cannot enter occupied spaces; check for a fuel or gas smell first.',
        'Record controller alarms and check the emergency-stop circuit before resetting anything.',
        'Check fuel level and valve position using the operator procedure; do not loosen fuel lines.',
        'Inspect battery terminals and measure battery voltage with a suitable meter.',
        'Check the air filter and visible intake path with the engine stopped.',
        'Prevent automatic start and isolate before any internal inspection; refer unresolved faults to the OEM.'
      ],
      safety: 'Run generators outdoors only: carbon monoxide is lethal and may not be smelled. Disable automatic start, isolate the ATS and utility supply before servicing, and keep clear of hot, moving and fuel-system parts. Never attempt to back-feed a building.',
      parts: [
        { d: 'Starting battery (confirm specification)', price: 65000 },
        { d: 'Air filter (confirm model)', price: 12000 }
      ],
      source: 'REHOTEQ field data'
    },
    {
      id: 'plumb-leak', trade: 'plumbing', cat: 'Domestic water pipework', symptom: 'Visible leak from a water pipe or fitting',
      code: '', freq: 'high',
      causes: [
        { t: 'Loose, cracked or incompatible fitting', p: 'HIGH', d: 'Movement, poor support or a mismatched joint can cause a persistent drip.' },
        { t: 'Corroded or split pipe section', p: 'HIGH', d: 'Age, water quality or external impact may have weakened the pipe wall.' },
        { t: 'Excess pressure or pressure surge', p: 'MED', d: 'A pressure problem can make more than one joint leak; inspect before replacing fittings.' },
        { t: 'Failed appliance hose or seal', p: 'MED', d: 'Check the appliance connection and washer before opening a wall or floor.' },
        { t: 'Condensation mistaken for a leak', p: 'LOW', d: 'Dry the surface and observe where the first moisture returns.' }
      ],
      checks: [
        'Identify the water source and protect people, property and nearby electrical equipment.',
        'Close the correct isolation valve and relieve pressure before loosening any joint.',
        'For hot water, allow the pipe or cylinder to cool and depressurise first.',
        'Dry the area and observe the exact point where water reappears.',
        'Replace damaged parts with compatible material and support the pipe correctly.',
        'Restore water gradually, inspect under pressure, and confirm the adjacent area is dry.'
      ],
      safety: 'Isolate the water supply and depressurise before cutting or loosening pipework. Hot-water systems can scald; let them cool first. If water is near electrical equipment, isolate the electrical supply safely and keep clear until the area is dry and inspected.',
      parts: [
        { d: 'Compatible pipe coupling', price: 2500 },
        { d: 'Thread seal tape', price: 800 },
        { d: 'Pipe section (size and material dependent)', price: 0 }
      ],
      source: 'REHOTEQ field data'
    },
    {
      id: 'fire-zonefault', trade: 'fire_access', cat: 'Fire alarm control panel', symptom: 'Fire alarm panel shows a zone or device fault',
      code: '', freq: 'med',
      causes: [
        { t: 'Open circuit or damaged field cable', p: 'HIGH', d: 'A loose terminal, cable damage or moisture can interrupt a zone or loop.' },
        { t: 'Device removed, contaminated or failed', p: 'MED', d: 'A detector head may be missing, dirty or at end of life.' },
        { t: 'Low battery or charger supply fault', p: 'MED', d: 'A mains or battery fault may appear alongside device warnings.' },
        { t: 'Incorrect isolator state after recent work', p: 'MED', d: 'A zone or loop isolator may have been left disabled.' },
        { t: 'Panel configuration or addressing issue', p: 'LOW', d: 'Addressable systems require the manufacturer procedure and correct device data.' }
      ],
      checks: [
        'Notify the responsible site contact and monitoring station before any test or isolation.',
        'Record the exact panel text, zone, device address and time of the event.',
        'Check visible indicators, supply status and battery condition without defeating protection.',
        'Inspect accessible cable and device connections under the site impairment permit.',
        'Test devices using the manufacturer method and record every result.',
        'Restore all zones, remove test mode and confirm normal status at the panel and monitoring station.'
      ],
      safety: 'A fire alarm is life-safety equipment. Notify the site responsible person and monitoring station before testing, obtain an impairment permit, and maintain the agreed fire watch. Never leave a zone bypassed: restore and verify normal status before leaving.',
      parts: [
        { d: 'Compatible detector head (confirm model)', price: 18000 },
        { d: 'Panel standby battery (confirm rating)', price: 22000 }
      ],
      source: 'REHOTEQ field data'
    },
    {
      id: 'smart-offline', trade: 'smarthome', cat: 'Smart home controls', symptom: 'Smart switch or sensor is offline in the home app',
      code: '', freq: 'high',
      causes: [
        { t: 'WiFi coverage or band mismatch', p: 'HIGH', d: 'Many devices need a stable 2.4 GHz connection and fail after router changes.' },
        { t: 'Device lost pairing after a power interruption', p: 'MED', d: 'A controlled re-pair may be needed after confirming local operation.' },
        { t: 'Hub or cloud service unavailable', p: 'MED', d: 'Check whether the problem affects one device or the entire platform.' },
        { t: 'Low-voltage supply or wiring fault', p: 'MED', d: 'Measure only at documented test points and isolate mains circuits before opening.' },
        { t: 'Firmware or account permissions changed', p: 'LOW', d: 'Customer account, ownership or an update may have changed access.' }
      ],
      checks: [
        'Ask whether manual control still works and whether the fault affects one device or the whole home.',
        'Check hub power, router status and 2.4 GHz coverage at the installed device.',
        'Check device and hub status lights against the manufacturer guide.',
        'Confirm customer-owned app account and permissions; do not collect or store passwords.',
        'Isolate and prove dead before opening mains-connected devices; keep SELV separate from mains.',
        'Re-pair only with customer approval, then test automation and manual override.'
      ],
      safety: 'Mains-connected smart modules can expose lethal voltage. Isolate, lock off and prove dead before opening; keep extra-low-voltage and mains wiring segregated. Never ask the customer to share a password: let them enter credentials on their own device.',
      parts: [
        { d: 'Compatible smart relay (confirm load rating)', price: 18000 },
        { d: 'Wireless hub (platform dependent)', price: 45000 }
      ],
      source: 'REHOTEQ field data'
    },
    {
      id: 'ev-nocharge', trade: 'ev', cat: 'AC EV charging point', symptom: 'Vehicle is plugged in but the charger will not start charging',
      code: '', freq: 'med',
      causes: [
        { t: 'Vehicle schedule or charge limit is active', p: 'HIGH', d: 'A vehicle timer or battery limit can prevent charging while the point appears ready.' },
        { t: 'Connector not fully latched or cable damaged', p: 'MED', d: 'Check the connector, pilot indication and visible cable condition.' },
        { t: 'Protective device has tripped', p: 'MED', d: 'A trip may indicate a real fault; never repeatedly reset without diagnosis.' },
        { t: 'Supply capacity or load management limit reached', p: 'MED', d: 'Dynamic load control may pause the point when the building demand is high.' },
        { t: 'Charger communication or firmware fault', p: 'LOW', d: 'Record the charger code and use the OEM diagnostic process.' }
      ],
      checks: [
        'Check the vehicle charge schedule, requested charge limit and dashboard message with the owner.',
        'Inspect the connector and cable for visible damage; stop using damaged equipment.',
        'Record charger LEDs, error code, model and serial number.',
        'Check the protective device status; do not repeatedly reset a device that trips again.',
        'Review supply and load-management status using the approved charger interface.',
        'A qualified EV electrician should verify earthing and protective-device operation before returning to service.'
      ],
      safety: 'EV circuits can carry sustained high current and may use residual-current protection with DC detection. Isolate, lock off and prove dead before electrical testing; verify protection to the charger manufacturer and local code. Do not repeatedly reset a tripping charger.',
      parts: [
        { d: 'Type 2 tethered cable (confirm charger model)', price: 65000 },
        { d: 'Manufacturer-approved RCD / protection device', price: 0 }
      ],
      source: 'REHOTEQ field data'
    }
  ];

  /* -------------------------------------------------------------------
     Default settings / plans
     ------------------------------------------------------------------- */
  const PLANS = {
    free:     { name: 'Free',     reports: 3,    quotes: 2, price: 0,     label: '₦0' },
    // yearPrice is what a year actually costs. Everything the app says about
    // the annual saving is worked out from it, so the two cannot drift.
    pro:      { name: 'Pro',      reports: -1,   quotes: -1, price: 3000, label: '₦3,000/mo', yearPrice: 30000 },
    // seats is how many technicians a Business subscription covers; extraSeat
    // is the monthly price of each seat beyond that (spec: ₦2,500/mo). The
    // app reads both from here so the seat screen can never disagree with
    // the price list — the same rule that killed the hardcoded ₦4,000.
    business: { name: 'Business', reports: -1,   quotes: -1, price: 15000, label: '₦15,000/mo', seats: 5, extraSeat: 2500 }
  };

  global.DATA = { TRADES, JOB_TYPES, CHECKLISTS, LIBRARY, PLANS };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.DATA;
})(typeof window !== 'undefined' ? window : globalThis);

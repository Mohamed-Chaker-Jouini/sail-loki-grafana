import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  parseNewZones, rowKey, esc, computeStats, applyFilters,
  loadHistory, sortBy, toggleAutoRefresh,
  setAllEntries, getFiltered
} from "./audit.js";

// ── GLOBAL DOM MOCKING SETUP ──────────────────────────────────────────────────
// Bun has no browser DOM. We build a minimal mock that covers every element
// the module touches so no function throws on startup or during tests.

const REQUIRED_IDS = [
  // stats bar
  's-total','s-total-sub','s-drift','s-drift-sub',
  's-add','s-add-sub','s-rem','s-rem-sub',
  's-zones','s-zones-sub','s-ret','s-ret-sub',
  // filters
  'f-search','f-type','f-zone','f-from','f-to',
  'filter-count',
  // layout
  'audit-body','empty-state','empty-msg',
  'loading-indicator','err-banner','err-detail',
  'last-refresh','auto-badge','btn-auto',
  'pag-top','pag-bottom','toast',
];

function makeMockElement(id = '') {
  const el = {
    id,
    textContent : '',
    value       : '',
    innerHTML   : '',
    style       : { display: '' },
    dataset     : {},
    options     : [],
    selectedIndex: 0,
    classList: {
      _classes : new Set(),
      toggle   : mock(function(cls) { 
        this._classes.has(cls) ? this._classes.delete(cls) : this._classes.add(cls);
        return this._classes.has(cls);
      }),
      add    : mock(function(cls)  { this._classes.add(cls); }),
      remove : mock(function(cls)  { this._classes.delete(cls); }),
      contains: mock(function(cls) { return this._classes.has(cls); }),
    },
    appendChild   : mock(() => {}),
    querySelector : mock(() => makeMockElement()),
    querySelectorAll: mock(() => []),
    scrollIntoView: mock(() => {}),
    click         : mock(() => {}),
  };
  // Mirror textContent writes to a readable string (stats tests rely on this)
  return el;
}

let mockElements = {};

function getOrCreate(id) {
  if (!mockElements[id]) mockElements[id] = makeMockElement(id);
  return mockElements[id];
}

beforeEach(() => {
  mockElements = {};
  // Pre-create all required elements with sensible filter defaults
  REQUIRED_IDS.forEach(id => getOrCreate(id));

  // Filter defaults that applyFilters() reads
  mockElements['f-search'].value = '';
  mockElements['f-type'].value   = '';
  mockElements['f-zone'].value   = '';
  mockElements['f-from'].value   = '';
  mockElements['f-to'].value     = '';

  global.document = {
    getElementById    : mock(id  => getOrCreate(id)),
    createElement     : mock(()  => makeMockElement()),
    querySelectorAll  : mock(()  => []),
  };

  global.location = { hash: '' };
  global.window   = {
    scrollTo        : mock(() => {}),
    addEventListener: mock(() => {}),
  };

  // showToast is called inside the module; expose it on global so the
  // module's closure can find it (the module calls the module-scoped fn,
  // but having it here prevents "not defined" if ever called globally)
  global.showToast = mock(() => {});

  // URL.createObjectURL / revokeObjectURL needed by exportCSV
  global.URL = {
    createObjectURL: mock(() => 'blob:mock'),
    revokeObjectURL: mock(() => {}),
  };
});


// ── 1. PURE FUNCTIONS ─────────────────────────────────────────────────────────
describe("Pure Functions", () => {

  describe("parseNewZones()", () => {
    test("handles undefined, null, and empty inputs", () => {
      expect(parseNewZones(undefined)).toEqual([]);
      expect(parseNewZones(null)).toEqual([]);
      expect(parseNewZones("")).toEqual([]);
      expect(parseNewZones("[]")).toEqual([]);
    });

    test("handles already-parsed arrays", () => {
      expect(parseNewZones(["ZONE1", "ZONE2"])).toEqual(["ZONE1", "ZONE2"]);
    });

    test("handles valid JSON strings", () => {
      expect(parseNewZones('["DMZ", "TRUST"]')).toEqual(["DMZ", "TRUST"]);
    });

    test("handles Python repr strings (single quotes)", () => {
      expect(parseNewZones("['DMZ', 'UNTRUST']")).toEqual(["DMZ", "UNTRUST"]);
    });

    test("handles raw unquoted bracket strings", () => {
      expect(parseNewZones("[DMZ, TRUST]")).toEqual(["DMZ", "TRUST"]);
    });
  });

  describe("esc()", () => {
    test("escapes HTML characters to prevent XSS", () => {
      expect(esc("<h1>Hello & Welcome</h1>")).toBe("&lt;h1&gt;Hello &amp; Welcome&lt;/h1&gt;");
      expect(esc('"Quote"')).toBe("&quot;Quote&quot;");
    });

    test("coerces non-string values", () => {
      expect(esc(42)).toBe("42");
      expect(esc(null)).toBe("null");
    });
  });

  describe("rowKey()", () => {
    test("generates stable deterministic keys", () => {
      expect(rowKey({ ts: 1680000000, run_id: "run-abc-123" }))
        .toBe("r-1680000000-run-abc-123");
    });

    test("strips special characters from run_id", () => {
      expect(rowKey({ ts: 100, run_id: "run!@#test" }))
        .toBe("r-100-run---test");
    });

    test("handles missing ts / run_id gracefully", () => {
      expect(rowKey({})).toBe("r-0-x");
    });
  });
});


// ── 2. STATE & UI LOGIC ───────────────────────────────────────────────────────
describe("State & UI Logic", () => {

  describe("computeStats()", () => {
    test("calculates totals, drifts, IPs added/removed, and new zones", () => {
      const data = [
        {
          changed: true,
          delta_map: { DMZ: { to_add: ["1.1.1.1"], to_remove: [] } },
          _nz: []
        },
        {
          changed: false,
          delta_map: { TRUST: { to_add: [], to_remove: ["2.2.2.2", "3.3.3.3"] } },
          _nz: ["NEW_ZONE"]
        },
      ];

      setAllEntries(data);
      computeStats(data);

      // textContent is always a string — compare with String()
      expect(mockElements['s-total'].textContent).toBe("2");
      expect(mockElements['s-drift'].textContent).toBe("1");
      expect(mockElements['s-add'].textContent).toBe("1");
      expect(mockElements['s-rem'].textContent).toBe("2");
      expect(mockElements['s-zones'].textContent).toBe("1");
    });

    test("handles empty data without throwing", () => {
      setAllEntries([]);
      expect(() => computeStats([])).not.toThrow();
      expect(mockElements['s-total'].textContent).toBe("0");
    });
  });

  describe("applyFilters()", () => {
    // Full entries with all fields applyFilters() accesses
    const baseData = [
      {
        changed   : true,
        run_id    : "drift-run",
        vsrx_ip   : "10.0.0.1",
        ts        : new Date('2023-01-15').getTime() / 1000,
        delta_map : { DMZ: { to_add: ["1.1.1.1"], to_remove: [] } },
        _nz       : [],
      },
      {
        changed   : false,
        run_id    : "clean-run",
        vsrx_ip   : "10.0.0.2",
        ts        : new Date('2023-06-01').getTime() / 1000,
        delta_map : { TRUST: { to_add: [], to_remove: [] } },
        _nz       : [],
      },
    ];

    beforeEach(() => setAllEntries(baseData));

    test("returns all records when no filters are set", () => {
      applyFilters();
      expect(getFiltered().length).toBe(2);
    });

    test("filters by text search on run_id", () => {
      mockElements['f-search'].value = "drift";
      applyFilters();
      const f = getFiltered();
      expect(f.length).toBe(1);
      expect(f[0].run_id).toBe("drift-run");
    });

    test("filters by status=drift", () => {
      mockElements['f-type'].value = "drift";
      applyFilters();
      const f = getFiltered();
      expect(f.length).toBe(1);
      expect(f[0].changed).toBe(true);
    });

    test("filters by status=clean", () => {
      mockElements['f-type'].value = "clean";
      applyFilters();
      const f = getFiltered();
      expect(f.length).toBe(1);
      expect(f[0].changed).toBe(false);
    });

    test("filters by date range (from)", () => {
      mockElements['f-from'].value = "2023-04-01";
      applyFilters();
      const f = getFiltered();
      expect(f.length).toBe(1);
      expect(f[0].run_id).toBe("clean-run");
    });

    test("filters by date range (to)", () => {
      mockElements['f-to'].value = "2023-03-01";
      applyFilters();
      const f = getFiltered();
      expect(f.length).toBe(1);
      expect(f[0].run_id).toBe("drift-run");
    });

    test("returns empty array when search matches nothing", () => {
      mockElements['f-search'].value = "zzz-no-match";
      applyFilters();
      expect(getFiltered().length).toBe(0);
    });
  });
});


// ── 3. ASYNC & NETWORK ────────────────────────────────────────────────────────
describe("Network Requests (loadHistory)", () => {
  let originalFetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(()  => { global.fetch = originalFetch; });

  test("successfully loads, parses new_zones, and populates filtered", async () => {
    global.fetch = mock(async (url) => {
      if (url.includes('/history'))
        return Response.json([
          { run_id: "abc", vsrx_ip: "1.2.3.4", ts: 1700000000,
            changed: true, delta_map: {}, new_zones: "['DMZ']" }
        ]);
      if (url.includes('/health'))
        return Response.json({ max_history: 5000 });
      return Response.json([]);
    });

    await loadHistory(false);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(getFiltered().length).toBe(1);
    expect(getFiltered()[0]._nz).toEqual(["DMZ"]);
  });

  test("shows error banner on HTTP 500", async () => {
    global.fetch = mock(async () => new Response("Server Error", { status: 500 }));

    await loadHistory(false);

    expect(mockElements['err-banner'].style.display).toBe('block');
    expect(mockElements['err-detail'].textContent).toContain('HTTP 500');
  });

  test("shows error banner on network failure", async () => {
    global.fetch = mock(async () => { throw new Error("Network down"); });

    await loadHistory(false);

    expect(mockElements['err-banner'].style.display).toBe('block');
    expect(mockElements['err-detail'].textContent).toContain('Network down');
  });
});


// ── 4. TIMERS ─────────────────────────────────────────────────────────────────
describe("Auto-Refresh Timer", () => {
  let originalSetInterval;
  let originalClearInterval;

  beforeEach(() => {
    originalSetInterval   = global.setInterval;
    originalClearInterval = global.clearInterval;
    global.setInterval    = mock(() => 999);
    global.clearInterval  = mock(() => {});
  });

  afterEach(() => {
    // Always leave the timer OFF so module state is clean for the next test
    // (call toggle once more if the badge is visible, i.e. timer is ON)
    if (mockElements['auto-badge'].style.display === 'inline-block') {
      toggleAutoRefresh();
    }
    global.setInterval    = originalSetInterval;
    global.clearInterval  = originalClearInterval;
  });

  test("enables auto-refresh: starts timer and updates button/badge", () => {
    toggleAutoRefresh(); // OFF → ON
    expect(global.setInterval).toHaveBeenCalledTimes(1);
    expect(mockElements['btn-auto'].textContent).toBe('Disable Auto-Refresh');
    expect(mockElements['auto-badge'].style.display).toBe('inline-block');
  });

  test("disables auto-refresh: clears correct timer ID and resets button/badge", () => {
    toggleAutoRefresh(); // OFF → ON
    toggleAutoRefresh(); // ON  → OFF
    expect(global.clearInterval).toHaveBeenCalledWith(999);
    expect(mockElements['btn-auto'].textContent).toBe('Enable Auto-Refresh');
    expect(mockElements['auto-badge'].style.display).toBe('none');
  });
});
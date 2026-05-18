import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { 
  parseNewZones, rowKey, esc, computeStats, applyFilters, 
  loadHistory, sortBy, toggleAutoRefresh, 
  setAllEntries, getFiltered 
} from "./audit.js";

// ── GLOBAL DOM MOCKING SETUP ──────────────────────────────────────────────────
// Bun doesn't have a browser DOM. We must mock the document object so our 
// vanilla JS doesn't crash when it tries to touch the UI.
beforeEach(() => {
  const mockElements = {};
  
  const createMockElement = () => ({
    textContent: "",
    value: "",
    innerHTML: "",
    style: { display: "" },
    dataset: {},
    classList: {
      toggle: mock(() => true),
      add: mock(() => {}),
      remove: mock(() => {})
    },
    appendChild: mock(() => {}),
    querySelector: mock(() => createMockElement()),
    scrollIntoView: mock(() => {})
  });

  global.document = {
    getElementById: mock((id) => {
      if (!mockElements[id]) mockElements[id] = createMockElement();
      return mockElements[id];
    }),
    createElement: mock(() => createMockElement()),
    querySelectorAll: mock(() => [])
  };

  // Mock global UI helpers called in the script
  global.location = { hash: "" };
  global.showToast = mock(() => {});
  global.render = mock(() => {}); 
  global.sortFiltered = mock(() => {});
  global.window = { scrollTo: mock(() => {}), addEventListener: mock(() => {}) };
});


// ── 1. PURE FUNCTIONS (Logic, Parsing, Formatting) ────────────────────────────
describe("Pure Functions", () => {
  describe("parseNewZones()", () => {
    test("handles undefined, null, and empty inputs", () => {
      expect(parseNewZones(undefined)).toEqual([]);
      expect(parseNewZones(null)).toEqual([]);
      expect(parseNewZones("")).toEqual([]);
      expect(parseNewZones("[]")).toEqual([]);
    });

    test("handles already parsed arrays", () => {
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
  });

  describe("rowKey()", () => {
    test("generates stable deterministic keys based on ts and run_id", () => {
      expect(rowKey({ ts: 1680000000, run_id: "run-abc-123" })).toBe("r-1680000000-run-abc-123");
    });

    test("strips special characters from run_id", () => {
      expect(rowKey({ ts: 100, run_id: "run!@#test" })).toBe("r-100-run---test");
    });
  });
});


// ── 2. STATE & UI FUNCTIONS (Stats, Filters, Sorting) ─────────────────────────
describe("State & UI Logic", () => {
  describe("computeStats()", () => {
    test("calculates totals, drifts, and IPs correctly", () => {
      const mockData = [
        { changed: true, delta_map: { "DMZ": { to_add: ["1.1.1.1"], to_remove: [] } }, _nz: [] },
        { changed: false, delta_map: { "TRUST": { to_add: [], to_remove: ["2.2.2.2", "3.3.3.3"] } }, _nz: ["NEW_ZONE"] }
      ];

      setAllEntries(mockData); 
      computeStats(mockData);

      // Verify it updated the mocked DOM correctly
      expect(document.getElementById("s-total").textContent).toBe(2);
      expect(document.getElementById("s-drift").textContent).toBe(1);
      expect(document.getElementById("s-add").textContent).toBe(1); 
      expect(document.getElementById("s-rem").textContent).toBe(2); 
      expect(document.getElementById("s-zones").textContent).toBe(1); 
    });
  });

  describe("applyFilters()", () => {
    test("filters by text search, status, and dates", () => {
      const mockData = [
        { changed: true, run_id: "drift-run", vsrx_ip: "10.0.0.1", ts: new Date('2023-01-01').getTime()/1000 },
        { changed: false, run_id: "clean-run", vsrx_ip: "10.0.0.2", ts: new Date('2023-06-01').getTime()/1000 }
      ];
      setAllEntries(mockData);

      // Set the values on the mocked elements directly without destroying their base properties
      document.getElementById('f-search').value = "drift";
      document.getElementById('f-type').value = "drift";
      document.getElementById('f-zone').value = "";
      document.getElementById('f-from').value = "2022-01-01";
      document.getElementById('f-to').value = "2024-01-01";

      applyFilters();
      const filtered = getFiltered();
      
      expect(filtered.length).toBe(1);
      expect(filtered[0].run_id).toBe("drift-run");
    });
  });
});


// ── 3. ASYNC & NETWORK (Fetch mocking) ────────────────────────────────────────
describe("Network Requests (loadHistory)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch; // Restore fetch
  });

  test("successfully loads, parses, and triggers renders", async () => {
    // Mock the HTTP responses
    global.fetch = mock(async (url) => {
      if (url.includes('/history')) {
        return Response.json([{ run_id: "abc", new_zones: "['DMZ']" }]);
      }
      if (url.includes('/health')) {
        return Response.json({ max_history: 5000 });
      }
    });

    await loadHistory(false);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(getFiltered().length).toBe(1);
    expect(getFiltered()[0]._nz).toEqual(["DMZ"]); // Verifies parseNewZones fired
  });

  test("shows error banner on HTTP failure", async () => {
    global.fetch = mock(async () => new Response("Error", { status: 500 }));
    
    await loadHistory(false);
    
    // Check that the error banner is displayed
    expect(document.getElementById('err-banner').style.display).toBe('block');
    
    // Check that the error text actually rendered into the detail span
    expect(document.getElementById('err-detail').textContent).toContain('HTTP 500');
  });
});


// ── 4. TIMERS (setInterval mocking) ───────────────────────────────────────────
describe("Auto-Refresh Timer", () => {
  let originalSetInterval;
  let originalClearInterval;

  beforeEach(() => {
    originalSetInterval = global.setInterval;
    originalClearInterval = global.clearInterval;
  });

  afterEach(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });

  test("toggles auto-refresh timer on and off", () => {
    global.setInterval = mock(() => 999); // Fake timer ID
    global.clearInterval = mock(() => {});

    // Turn ON
    toggleAutoRefresh();
    expect(global.setInterval).toHaveBeenCalled();
    expect(document.getElementById('btn-auto').textContent).toBe('Disable Auto-Refresh');
    
    // Turn OFF
    toggleAutoRefresh();
    expect(global.clearInterval).toHaveBeenCalledWith(999);
    expect(document.getElementById('btn-auto').textContent).toBe('Enable Auto-Refresh');
  });
});
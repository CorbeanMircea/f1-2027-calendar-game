(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var box = document.getElementById("next-race-content");
  if (!box) { return; }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function showMessage(text) {
    box.textContent = "";
    box.appendChild(el("p", "placeholder", text));
  }

  var monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });

  function parseDay(isoDate) {
    return new Date(isoDate + "T00:00:00Z");
  }

  function formatRange(startIso, endIso) {
    var a = parseDay(startIso);
    var b = parseDay(endIso);
    var aMonth = monthFormat.format(a);
    var bMonth = monthFormat.format(b);
    var year = b.getUTCFullYear();
    if (aMonth === bMonth) {
      return a.getUTCDate() + "\u2013" + b.getUTCDate() + " " + aMonth + " " + year;
    }
    return a.getUTCDate() + " " + aMonth + " \u2013 " + b.getUTCDate() + " " + bMonth + " " + year;
  }

  function daysUntil(isoDate, todayIso) {
    return Math.round((parseDay(isoDate) - parseDay(todayIso)) / 86400000);
  }

  function render(ev, todayIso) {
    box.textContent = "";

    box.appendChild(el("p", "race-round", "Round " + ev.round + " \u00B7 " + ev.season));
    box.appendChild(el("h3", "race-name", ev.name));
    box.appendChild(el("p", "race-meta", ev.circuit + ", " + ev.locality + ", " + ev.country));
    box.appendChild(el("p", "race-dates", formatRange(ev.start_date, ev.end_date)));

    var badges = el("div", "race-badges");
    var untilStart = daysUntil(ev.start_date, todayIso);
    var countdown;
    if (untilStart > 1) {
      countdown = "Weekend starts in " + untilStart + " days";
    } else if (untilStart === 1) {
      countdown = "Weekend starts tomorrow";
    } else {
      countdown = "Race weekend is on now";
    }
    badges.appendChild(el("span", "badge", countdown));
    if (ev.has_sprint) {
      badges.appendChild(el("span", "badge badge-sprint", "Sprint weekend"));
    }
    if (ev.status !== "scheduled") {
      badges.appendChild(el("span", "badge", "Status: " + ev.status));
    }
    box.appendChild(badges);

    box.appendChild(el("p", "race-note", "Session times to be confirmed. Predictions open once they are."));
  }

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    showMessage("Site configuration is incomplete.");
    return;
  }

  var todayIso = new Date().toISOString().slice(0, 10);
  var query = "/rest/v1/events" +
    "?select=id,season,round,name,circuit,locality,country,start_date,end_date,has_sprint,status" +
    "&season=eq.2027" +
    "&status=neq.cancelled" +
    "&end_date=gte." + todayIso +
    "&order=start_date.asc" +
    "&limit=1";

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 10000);

  fetch(cfg.SUPABASE_URL + query, {
    headers: {
      "apikey": cfg.SUPABASE_PUBLISHABLE_KEY,
      "Accept": "application/json"
    },
    signal: controller.signal
  })
    .then(function (response) {
      if (!response.ok) { throw new Error("HTTP " + response.status); }
      return response.json();
    })
    .then(function (rows) {
      clearTimeout(timer);
      if (!Array.isArray(rows) || rows.length === 0) {
        showMessage("No upcoming races found.");
        return;
      }
      render(rows[0], todayIso);
    })
    .catch(function (err) {
      clearTimeout(timer);
      console.error("Could not load next race:", err);
      showMessage("Could not load the schedule. Please try again later.");
    });
})();
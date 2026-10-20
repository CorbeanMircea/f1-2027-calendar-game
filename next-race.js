(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var box = document.getElementById("next-race-content");
  if (!box) { return; }

  var TYPE_LABEL = {
    sprint_qualifying: "Sprint Qualifying",
    sprint: "Sprint",
    qualifying: "Qualifying",
    race: "Race"
  };

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

  function whenText(iso) {
    return new Date(iso).toLocaleString([], {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  function untilText(ms) {
    var minutes = Math.max(0, Math.floor(ms / 60000));
    var days = Math.floor(minutes / 1440);
    var hours = Math.floor((minutes % 1440) / 60);
    var mins = minutes % 60;
    if (days > 0) { return days + " d " + hours + " h"; }
    if (hours > 0) { return hours + " h " + mins + " min"; }
    return mins + " min";
  }

  function fetchJson(path, signal) {
    return fetch(cfg.SUPABASE_URL + path, {
      headers: { "apikey": cfg.SUPABASE_PUBLISHABLE_KEY, "Accept": "application/json" },
      signal: signal
    }).then(function (response) {
      if (!response.ok) { throw new Error("HTTP " + response.status); }
      return response.json();
    });
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

    var extra = el("div", "race-extra");
    extra.appendChild(el("p", "race-note", "Loading session times..."));
    box.appendChild(extra);
    return extra;
  }

  function loadSessions(ev, extra) {
    fetchJson("/rest/v1/sessions?select=session_type,start_utc&event_id=eq." + encodeURIComponent(ev.id))
      .then(function (rows) {
        var timed = rows.filter(function (r) { return r.start_utc; });
        extra.textContent = "";

        if (timed.length === 0) {
          extra.appendChild(el("p", "race-note", "Session times to be confirmed. Predictions open once they are."));
          return;
        }

        timed.sort(function (a, b) { return Date.parse(a.start_utc) - Date.parse(b.start_utc); });
        timed.forEach(function (r) {
          extra.appendChild(el("p", "race-meta",
            (TYPE_LABEL[r.session_type] || r.session_type) + " \u00B7 " + whenText(r.start_utc)));
        });

        var now = Date.now();
        var locks = timed.filter(function (r) {
          return (r.session_type === "qualifying" || r.session_type === "sprint_qualifying") &&
            Date.parse(r.start_utc) > now;
        });
        if (locks.length > 0) {
          var next = locks[0];
          extra.appendChild(el("p", "race-note",
            "Predictions lock in " + untilText(Date.parse(next.start_utc) - now) +
            " (when " + TYPE_LABEL[next.session_type] + " starts)."));
        } else {
          extra.appendChild(el("p", "race-note", "Predictions are closed for this weekend."));
        }
      })
      .catch(function (err) {
        console.error(err);
        extra.textContent = "";
        extra.appendChild(el("p", "race-note", "Session times are not available right now."));
      });
  }

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    showMessage("Site configuration is incomplete.");
    return;
  }

  var todayIso = new Date().toISOString().slice(0, 10);
  var query = "/rest/v1/events" +
    "?select=id,season,round,name,circuit,locality,country,start_date,end_date,has_sprint,status" +
    "&season=lt.9000" +
    "&status=neq.cancelled" +
    "&end_date=gte." + todayIso +
    "&order=start_date.asc" +
    "&limit=1";

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 10000);

  fetchJson(query, controller.signal)
    .then(function (rows) {
      clearTimeout(timer);
      if (!Array.isArray(rows) || rows.length === 0) {
        showMessage("No upcoming races found.");
        return;
      }
      var extra = render(rows[0], todayIso);
      loadSessions(rows[0], extra);
    })
    .catch(function (err) {
      clearTimeout(timer);
      console.error("Could not load next race:", err);
      showMessage("Could not load the schedule. Please try again later.");
    });
})();
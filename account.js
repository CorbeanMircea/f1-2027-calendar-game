(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};

  var messageEl = document.getElementById("auth-message");
  var signedOutView = document.getElementById("signed-out-view");
  var signedInView = document.getElementById("signed-in-view");
  var emailDisplay = document.getElementById("signed-in-email");
  var form = document.getElementById("auth-form");
  var emailInput = document.getElementById("email");
  var passwordInput = document.getElementById("password");
  var signUpButton = document.getElementById("sign-up-button");
  var signInButton = document.getElementById("sign-in-button");
  var signOutButton = document.getElementById("sign-out-button");

  var membershipStatus = document.getElementById("membership-status");
  var joinSection = document.getElementById("join-section");
  var joinForm = document.getElementById("join-form");
  var joinNameInput = document.getElementById("join-name");
  var joinCodeInput = document.getElementById("join-code");
  var joinButton = document.getElementById("join-button");
  var memberSection = document.getElementById("member-section");
  var memberGroup = document.getElementById("member-group");
  var memberName = document.getElementById("member-name");
  var memberRole = document.getElementById("member-role");

  var currentUser = null;

  function setMessage(kind, text) {
    messageEl.className = "message" + (kind ? " " + kind : "");
    messageEl.textContent = text || "";
  }

  function setBusy(busy) {
    signUpButton.disabled = busy;
    signInButton.disabled = busy;
    signOutButton.disabled = busy;
    joinButton.disabled = busy;
  }

  function resetMembershipView() {
    membershipStatus.textContent = "";
    membershipStatus.hidden = true;
    joinSection.hidden = true;
    memberSection.hidden = true;
    memberGroup.textContent = "";
    memberName.textContent = "";
    memberRole.textContent = "";
    if (window.AccountProfile) { window.AccountProfile.clear(); }
  }

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    setMessage("error", "Site configuration is incomplete.");
    signUpButton.disabled = true;
    signInButton.disabled = true;
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  function refreshMembership() {
    if (!currentUser) { return; }
    var uid = currentUser.id;

    resetMembershipView();
    membershipStatus.textContent = "Checking group membership...";
    membershipStatus.hidden = false;

    Promise.all([
      client.from("group_members").select("role, groups(name)").eq("user_id", uid).limit(1),
      client.from("profiles").select("display_name").eq("id", uid).limit(1)
    ]).then(function (results) {
      if (!currentUser || currentUser.id !== uid) { return; }
      var memberResult = results[0];
      var profileResult = results[1];

      if (memberResult.error || profileResult.error) {
        console.error(memberResult.error || profileResult.error);
        membershipStatus.textContent = "Could not check group membership. Please reload the page.";
        return;
      }

      var member = memberResult.data && memberResult.data[0];
      if (!member) {
        membershipStatus.hidden = true;
        joinSection.hidden = false;
        return;
      }

      var group = member.groups;
      if (Array.isArray(group)) { group = group[0]; }
      memberGroup.textContent = group && group.name ? group.name : "(unknown)";
      var profile = profileResult.data && profileResult.data[0];
      memberName.textContent = profile ? profile.display_name : "";
      memberRole.textContent = member.role;

      membershipStatus.hidden = true;
      memberSection.hidden = false;
      if (window.AccountProfile) {
        window.AccountProfile.render(client, currentUser, profile ? profile.display_name : "");
      }
    }).catch(function (err) {
      console.error(err);
      membershipStatus.textContent = "Could not check group membership. Please reload the page.";
    });
  }

  // Update the page for a session (or no session).
  function applySession(session) {
    if (session && session.user) {
      var changed = !currentUser || currentUser.id !== session.user.id;
      currentUser = session.user;
      emailDisplay.textContent = currentUser.email || "";
      signedOutView.hidden = true;
      signedInView.hidden = false;
      if (changed) { setTimeout(refreshMembership, 0); }
    } else {
      currentUser = null;
      emailDisplay.textContent = "";
      resetMembershipView();
      signedInView.hidden = true;
      signedOutView.hidden = false;
    }
  }

  function readCredentials() {
    var email = emailInput.value.trim();
    var password = passwordInput.value;
    if (!email || email.indexOf("@") < 1) {
      setMessage("error", "Please enter a valid email address.");
      return null;
    }
    if (password.length < 8) {
      setMessage("error", "Password must be at least 8 characters.");
      return null;
    }
    return { email: email, password: password };
  }

  function handleSignIn() {
    var creds = readCredentials();
    if (!creds) { return; }
    setBusy(true);
    setMessage("", "Signing in...");
    client.auth.signInWithPassword(creds).then(function (result) {
      setBusy(false);
      if (result.error) {
        setMessage("error", result.error.message);
        return;
      }
      passwordInput.value = "";
      setMessage("ok", "Signed in.");
    }).catch(function (err) {
      setBusy(false);
      console.error(err);
      setMessage("error", "Something went wrong. Please try again.");
    });
  }

  function handleSignUp() {
    var creds = readCredentials();
    if (!creds) { return; }
    setBusy(true);
    setMessage("", "Creating account...");
    client.auth.signUp(creds).then(function (result) {
      setBusy(false);
      if (result.error) {
        setMessage("error", result.error.message);
        return;
      }
      passwordInput.value = "";
      if (result.data && result.data.session) {
        setMessage("ok", "Account created. You are signed in.");
      } else {
        setMessage("ok", "Account created. If asked, confirm your email, then sign in.");
      }
    }).catch(function (err) {
      setBusy(false);
      console.error(err);
      setMessage("error", "Something went wrong. Please try again.");
    });
  }

  function handleSignOut() {
    setBusy(true);
    client.auth.signOut().then(function (result) {
      setBusy(false);
      if (result.error) {
        setMessage("error", result.error.message);
        return;
      }
      setMessage("ok", "Signed out.");
    }).catch(function (err) {
      setBusy(false);
      console.error(err);
      setMessage("error", "Something went wrong. Please try again.");
    });
  }

  function handleJoin(event) {
    event.preventDefault();
    var name = joinNameInput.value.trim();
    var code = joinCodeInput.value.trim();
    if (name.length < 2 || name.length > 30) {
      setMessage("error", "Display name must be 2 to 30 characters.");
      return;
    }
    if (!code) {
      setMessage("error", "Please enter the invite code.");
      return;
    }
    setBusy(true);
    setMessage("", "Joining group...");
    client.rpc("join_group", { p_invite_code: code, p_display_name: name }).then(function (result) {
      setBusy(false);
      if (result.error) {
        setMessage("error", result.error.message);
        return;
      }
      joinCodeInput.value = "";
      setMessage("ok", "Welcome to the group!");
      refreshMembership();
    }).catch(function (err) {
      setBusy(false);
      console.error(err);
      setMessage("error", "Something went wrong. Please try again.");
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    handleSignIn();
  });
  signUpButton.addEventListener("click", handleSignUp);
  signOutButton.addEventListener("click", handleSignOut);
  joinForm.addEventListener("submit", handleJoin);

  // Only update the page inside this callback; do not call the database here.
  client.auth.onAuthStateChange(function (event, session) {
    applySession(session);
  });

  client.auth.getSession().then(function (result) {
    applySession(result.data && result.data.session);
  });
})();
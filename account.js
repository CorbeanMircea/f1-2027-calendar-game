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

  var passwordField = document.getElementById("password-field");
  var forgotButton = document.getElementById("forgot-button");
  var resetHelp = document.getElementById("reset-help");
  var resetActions = document.getElementById("reset-actions");
  var resetSendButton = document.getElementById("reset-send-button");
  var resetBackButton = document.getElementById("reset-back-button");
  var signInActions = signInButton.parentNode;
  var recoveryPanel = document.getElementById("recovery-panel");
  var recoveryForm = document.getElementById("recovery-form");
  var recoverySaveButton = document.getElementById("recovery-save-button");
  var changeForm = document.getElementById("change-form");
  var changeSaveButton = document.getElementById("change-save-button");

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
    resetSendButton.disabled = busy;
    recoverySaveButton.disabled = busy;
    changeSaveButton.disabled = busy;
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

  // ---------- Forgot password, and choosing a new one ----------

  function showResetMode(on) {
    passwordField.hidden = on;
    signInActions.hidden = on;
    forgotButton.parentNode.hidden = on;
    resetHelp.hidden = !on;
    resetActions.hidden = !on;
    setMessage("", "");
    if (on) { emailInput.focus(); }
  }

  function handleSendReset() {
    var email = emailInput.value.trim();
    if (!email || email.indexOf("@") < 1) {
      setMessage("error", "Please enter the email address you signed up with.");
      return;
    }
    setBusy(true);
    setMessage("", "Sending...");
    var back = window.location.origin + window.location.pathname;
    client.auth.resetPasswordForEmail(email, { redirectTo: back }).then(function (result) {
      setBusy(false);
      if (result.error) {
        console.error(result.error);
        setMessage("error", result.error.status === 429
          ? "Too many emails were sent. Please wait a few minutes and try again."
          : "Could not send the email. Please try again.");
        return;
      }
      // The same answer whether or not the address has an account, so nobody can probe for accounts.
      setMessage("ok", "If that address has an account, a link to choose a new password is on its way. Check your spam folder too.");
    }).catch(function (err) {
      setBusy(false);
      console.error(err);
      setMessage("error", "Something went wrong. Please try again.");
    });
  }

  function savePassword(first, second, done) {
    var a = first.value;
    var b = second.value;
    if (a.length < 8) {
      setMessage("error", "The new password must have at least 8 characters.");
      return;
    }
    if (a !== b) {
      setMessage("error", "The two passwords do not match.");
      return;
    }
    setBusy(true);
    setMessage("", "Saving...");
    client.auth.updateUser({ password: a }).then(function (result) {
      setBusy(false);
      if (result.error) {
        console.error(result.error);
        setMessage("error", result.error.message || "Could not change the password.");
        return;
      }
      first.value = "";
      second.value = "";
      done();
    }).catch(function (err) {
      setBusy(false);
      console.error(err);
      setMessage("error", "Something went wrong. Please try again.");
    });
  }

  function clearRecoveryFromAddress() {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  forgotButton.addEventListener("click", function () { showResetMode(true); });
  resetBackButton.addEventListener("click", function () { showResetMode(false); });
  resetSendButton.addEventListener("click", handleSendReset);

  recoveryForm.addEventListener("submit", function (event) {
    event.preventDefault();
    savePassword(document.getElementById("new-password"), document.getElementById("new-password-2"), function () {
      recoveryPanel.hidden = true;
      clearRecoveryFromAddress();
      setMessage("ok", "Your password has been changed. You are signed in.");
    });
  });

  changeForm.addEventListener("submit", function (event) {
    event.preventDefault();
    savePassword(document.getElementById("change-password"), document.getElementById("change-password-2"), function () {
      document.getElementById("security-details").open = false;
      setMessage("ok", "Your password has been changed.");
    });
  });

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
    if (event === "PASSWORD_RECOVERY") {
      // The player came here from the "choose a new password" email.
      recoveryPanel.hidden = false;
      setMessage("", "");
      var first = document.getElementById("new-password");
      if (first && first.focus) { first.focus(); }
    }
  });

  client.auth.getSession().then(function (result) {
    applySession(result.data && result.data.session);
  });
})();
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

  function setMessage(kind, text) {
    messageEl.className = "message" + (kind ? " " + kind : "");
    messageEl.textContent = text || "";
  }

  function setBusy(busy) {
    signUpButton.disabled = busy;
    signInButton.disabled = busy;
    signOutButton.disabled = busy;
  }

  function showSignedIn(user) {
    emailDisplay.textContent = user.email || "";
    signedOutView.hidden = true;
    signedInView.hidden = false;
  }

  function showSignedOut() {
    emailDisplay.textContent = "";
    signedInView.hidden = true;
    signedOutView.hidden = false;
  }

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    setMessage("error", "Site configuration is incomplete.");
    signUpButton.disabled = true;
    signInButton.disabled = true;
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

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

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    handleSignIn();
  });
  signUpButton.addEventListener("click", handleSignUp);
  signOutButton.addEventListener("click", handleSignOut);

  // Update the page whenever the sign-in state changes. Only touch the page here.
  client.auth.onAuthStateChange(function (event, session) {
    if (session && session.user) {
      showSignedIn(session.user);
    } else {
      showSignedOut();
    }
  });

  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (session && session.user) {
      showSignedIn(session.user);
    } else {
      showSignedOut();
    }
  });
})();
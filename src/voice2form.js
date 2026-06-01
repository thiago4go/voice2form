(function (global) {
  var MIN_RECORDING_MS = 2000;
  var DEFAULT_RECORDING_MS = 8000;

  function Voice2Form(options) {
    if (!options || !options.backendUrl) {
      throw new Error("voice2form requires a backendUrl");
    }

    var configuredRecordingMs =
      options.maxRecordingMs == null ? DEFAULT_RECORDING_MS : Number(options.maxRecordingMs);
    if (!isFinite(configuredRecordingMs)) {
      configuredRecordingMs = DEFAULT_RECORDING_MS;
    }

    this.options = {
      backendUrl: options.backendUrl.replace(/\/$/, ""),
      apiKey: options.apiKey || "",
      model: options.model || "gpt-4o-mini",
      selector: options.selector || "form",
      openAIPath: options.openAIPath || "/v1/chat/completions",
      transcriptionPath: options.transcriptionPath || "/v1/audio/transcriptions",
      transcriptionModel: options.transcriptionModel || "gpt-4o-mini-transcribe",
      autoInit: options.autoInit !== false,
      speak: options.speak !== false,
      speakWithBackend: options.speakWithBackend === true,
      ttsPath: options.ttsPath || "/v1/audio/speech",
      ttsModel: options.ttsModel || "gpt-4o-mini-tts",
      language:
        options.language ||
        (typeof navigator !== "undefined" && navigator.language) ||
        "en-US",
      buttonLabel: options.buttonLabel || "🎤 Start voice walkthrough",
      sendLabel: options.sendLabel || "Send",
      inputPlaceholder: options.inputPlaceholder || "Type your answer",
      maxRecordingMs: Math.max(MIN_RECORDING_MS, configuredRecordingMs),
      systemPrompt:
        options.systemPrompt ||
        "You are a form-filling assistant. Return only JSON with {fields, reply}. fields is an object where each key is a form field name and each value is the text value to set.",
    };

    this.supportsSpeechRecognition =
      typeof global !== "undefined" &&
      ("SpeechRecognition" in global || "webkitSpeechRecognition" in global);

    this.supportsMediaRecorder =
      typeof global !== "undefined" &&
      "MediaRecorder" in global &&
      typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function";

    this.formsState = new WeakMap();

    if (this.options.autoInit) {
      this.init();
    }
  }

  Voice2Form.prototype.init = function () {
    var forms = document.querySelectorAll(this.options.selector);

    for (var i = 0; i < forms.length; i += 1) {
      this.attach(forms[i]);
    }
  };

  Voice2Form.prototype.attach = function (form) {
    if (!form || form.dataset.voice2formAttached === "true") {
      return;
    }

    var panel = document.createElement("div");
    panel.style.margin = "12px 0";
    panel.style.padding = "10px";
    panel.style.border = "1px solid #ddd";
    panel.style.borderRadius = "8px";
    panel.style.background = "#fafafa";

    var button = document.createElement("button");
    button.type = "button";
    button.textContent = this.options.buttonLabel;

    var status = document.createElement("div");
    status.setAttribute("aria-live", "polite");
    status.style.fontSize = "12px";
    status.style.marginTop = "8px";

    var log = document.createElement("div");
    log.setAttribute("aria-live", "polite");
    log.style.marginTop = "8px";
    log.style.maxHeight = "220px";
    log.style.overflowY = "auto";
    log.style.fontSize = "14px";

    var controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "8px";
    controls.style.marginTop = "8px";

    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = this.options.inputPlaceholder;
    input.style.flex = "1";

    var send = document.createElement("button");
    send.type = "button";
    send.textContent = this.options.sendLabel;

    controls.appendChild(input);
    controls.appendChild(send);

    panel.appendChild(button);
    panel.appendChild(status);
    panel.appendChild(log);
    panel.appendChild(controls);

    form.appendChild(panel);

    var state = {
      running: false,
      pendingResolver: null,
      ui: {
        button: button,
        status: status,
        log: log,
        input: input,
        send: send,
      },
    };

    this.formsState.set(form, state);

    var self = this;

    var resolveTypedInput = function () {
      var text = (input.value || "").trim();
      if (!text) {
        return;
      }

      input.value = "";
      self.appendMessage(log, "user", text);

      if (state.pendingResolver) {
        var resolver = state.pendingResolver;
        state.pendingResolver = null;
        resolver(text);
      }
    };

    send.addEventListener("click", resolveTypedInput);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        resolveTypedInput();
      }
    });

    button.addEventListener("click", function () {
      self.start(form);
    });

    form.dataset.voice2formAttached = "true";
  };

  Voice2Form.prototype.start = async function (form) {
    var state = this.formsState.get(form);
    if (!state || state.running) {
      return;
    }

    state.running = true;
    state.ui.button.disabled = true;

    try {
      await this.runNarrativeWalkthrough(form, state.ui);
    } catch (error) {
      this.updateStatus(state.ui.status, "Error: " + error.message);
    } finally {
      state.running = false;
      state.ui.button.disabled = false;
      state.pendingResolver = null;
    }
  };

  Voice2Form.prototype.runNarrativeWalkthrough = async function (form, ui) {
    var schema = this.getFormSchema(form);
    var pending = this.filterPendingFields(form, schema);

    if (!pending.length) {
      var completedMsg = "All fields are already filled.";
      this.updateStatus(ui.status, completedMsg);
      this.appendMessage(ui.log, "assistant", completedMsg);
      await this.speak(completedMsg);
      return;
    }

    this.updateStatus(ui.status, "Starting voice walkthrough...");
    this.appendMessage(ui.log, "assistant", "Hi! I'll guide you through this form step by step.");
    await this.speak("Hi! I'll guide you through this form step by step.");

    for (var i = 0; i < pending.length; i += 1) {
      var field = pending[i];
      var fieldTitle = field.label || field.name || field.id || "this field";
      var question =
        "Step " +
        (i + 1) +
        " of " +
        pending.length +
        ": What should I put for " +
        fieldTitle +
        "?";

      this.appendMessage(ui.log, "assistant", question);
      await this.speak(question);

      var answer = await this.captureUserInput(ui);
      var mapping = await this.mapTranscriptToFields(
        answer,
        [field],
        "Current step: fill field " + JSON.stringify(field)
      );

      this.applyFields(form, mapping.fields || {});

      var ack =
        (mapping.reply && String(mapping.reply).trim()) ||
        "Got it. I updated " + fieldTitle + ".";
      this.appendMessage(ui.log, "assistant", ack);
      await this.speak(ack);
    }

    var endMessage = "Done. I completed the walkthrough and filled the form.";
    this.updateStatus(ui.status, endMessage);
    this.appendMessage(ui.log, "assistant", endMessage);
    await this.speak(endMessage);
  };

  Voice2Form.prototype.captureUserInput = async function (ui) {
    this.updateStatus(ui.status, "Listening...");

    if (this.supportsSpeechRecognition) {
      try {
        var spoken = await this.listenOnce();
        this.appendMessage(ui.log, "user", spoken);
        return spoken;
      } catch (error) {
        this.updateStatus(ui.status, "Speech recognition failed. You can type your answer.");
      }
    }

    if (this.supportsMediaRecorder) {
      try {
        this.updateStatus(ui.status, "Recording audio for transcription...");
        var transcribed = await this.recordAndTranscribe();
        this.appendMessage(ui.log, "user", transcribed);
        return transcribed;
      } catch (error) {
        this.updateStatus(ui.status, "Audio transcription failed. You can type your answer.");
      }
    }

    this.updateStatus(ui.status, "Type your answer and press Send.");
    return this.waitForTypedInput(ui);
  };

  Voice2Form.prototype.waitForTypedInput = function (ui) {
    var self = this;
    return new Promise(function (resolve) {
      var activeForm = self.findFormByUI(ui);
      var state = activeForm ? self.formsState.get(activeForm) : null;

      if (!state) {
        resolve("");
        return;
      }

      state.pendingResolver = resolve;
      ui.input.focus();
    });
  };

  Voice2Form.prototype.findFormByUI = function (ui) {
    var forms = document.querySelectorAll(this.options.selector);
    for (var i = 0; i < forms.length; i += 1) {
      var state = this.formsState.get(forms[i]);
      if (state && state.ui === ui) {
        return forms[i];
      }
    }
    return null;
  };

  Voice2Form.prototype.listenOnce = function () {
    var Recognition = global.SpeechRecognition || global.webkitSpeechRecognition;
    var recognition = new Recognition();
    recognition.lang = this.options.language;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    return new Promise(function (resolve, reject) {
      var settled = false;

      recognition.onresult = function (event) {
        settled = true;
        var transcript = event.results[0][0].transcript;
        resolve(transcript);
      };
      recognition.onerror = function (event) {
        settled = true;
        reject(new Error(event.error || "Speech recognition failed"));
      };
      recognition.onnomatch = function () {
        settled = true;
        reject(new Error("No speech recognized"));
      };
      recognition.onend = function () {
        if (!settled) {
          settled = true;
          reject(new Error("Speech recognition ended before receiving input"));
        }
      };
      recognition.start();
    });
  };

  Voice2Form.prototype.recordAndTranscribe = async function () {
    var self = this;
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var recorder = new MediaRecorder(stream);
    var chunks = [];

    return new Promise(function (resolve, reject) {
      var stopTimer = null;

      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onerror = function () {
        reject(new Error("Audio recording failed"));
      };

      recorder.onstop = async function () {
        clearTimeout(stopTimer);
        var mimeType = recorder.mimeType || "audio/webm";
        var blob = new Blob(chunks, { type: mimeType });

        for (var i = 0; i < stream.getTracks().length; i += 1) {
          stream.getTracks()[i].stop();
        }

        if (!blob.size) {
          reject(new Error("No audio captured"));
          return;
        }

        try {
          var text = await self.transcribeAudio(blob, mimeType);
          resolve(text);
        } catch (error) {
          reject(error);
        }
      };

      recorder.start();
      stopTimer = setTimeout(function () {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      }, self.options.maxRecordingMs);
    });
  };

  Voice2Form.prototype.transcribeAudio = async function (audioBlob, mimeType) {
    var formData = new FormData();
    var extension = this.mimeTypeToExtension(mimeType || audioBlob.type || "audio/webm");
    formData.append("file", audioBlob, "voice2form-input." + extension);
    formData.append("model", this.options.transcriptionModel);
    formData.append("language", this.options.language);

    var response = await fetch(this.options.backendUrl + this.options.transcriptionPath, {
      method: "POST",
      headers: this.authHeaderOnly(),
      body: formData,
    });

    if (!response.ok) {
      throw new Error("Transcription request failed with status " + response.status);
    }

    var data = await response.json();
    var text = data && data.text ? String(data.text).trim() : "";
    if (!text) {
      throw new Error("Empty transcription result");
    }

    return text;
  };

  Voice2Form.prototype.authHeaderOnly = function () {
    if (!this.options.apiKey) {
      return {};
    }

    return {
      Authorization: "Bearer " + this.options.apiKey,
    };
  };

  Voice2Form.prototype.jsonHeaders = function () {
    var headers = {
      "Content-Type": "application/json",
    };
    var authHeaders = this.authHeaderOnly();
    if (authHeaders.Authorization) {
      headers.Authorization = authHeaders.Authorization;
    }
    return headers;
  };

  Voice2Form.prototype.mimeTypeToExtension = function (mimeType) {
    var type = String(mimeType || "").toLowerCase();
    if (type.indexOf("ogg") !== -1) {
      return "ogg";
    }
    if (type.indexOf("mp4") !== -1 || type.indexOf("m4a") !== -1) {
      return "m4a";
    }
    if (type.indexOf("mpeg") !== -1 || type.indexOf("mp3") !== -1) {
      return "mp3";
    }
    if (type.indexOf("wav") !== -1) {
      return "wav";
    }
    return "webm";
  };

  Voice2Form.prototype.updateStatus = function (node, text) {
    if (node) {
      node.textContent = text;
    }
  };

  Voice2Form.prototype.appendMessage = function (logNode, role, text) {
    if (!logNode) {
      return;
    }

    var line = document.createElement("div");
    line.style.margin = "4px 0";
    line.textContent = (role === "assistant" ? "Assistant: " : "You: ") + String(text || "");
    logNode.appendChild(line);
    logNode.scrollTop = logNode.scrollHeight;
  };

  Voice2Form.prototype.getFormSchema = function (form) {
    var fields = [];
    var controls = form.querySelectorAll("input, textarea, select");

    for (var i = 0; i < controls.length; i += 1) {
      var field = controls[i];
      var type = (field.type || "").toLowerCase();

      if (type === "hidden" || type === "submit" || type === "button" || type === "file") {
        continue;
      }

      fields.push({
        name: field.name || "",
        id: field.id || "",
        type: type || field.tagName.toLowerCase(),
        placeholder: field.placeholder || "",
        label: this.findLabelText(form, field),
      });
    }

    return fields;
  };

  Voice2Form.prototype.filterPendingFields = function (form, schema) {
    var pending = [];

    for (var i = 0; i < schema.length; i += 1) {
      var field = schema[i];
      var candidate =
        (field.name && this.getByName(form, field.name)) ||
        (field.id && this.getById(form, field.id));

      if (!candidate) {
        continue;
      }

      if (!this.hasValue(candidate, form)) {
        pending.push(field);
      }
    }

    return pending;
  };

  Voice2Form.prototype.hasValue = function (field, form) {
    var type = (field.type || "").toLowerCase();

    if (type === "checkbox") {
      return field.checked;
    }

    if (type === "radio") {
      var radios = field.name ? this.getByNameAll(form, field.name, "input[type='radio']") : [field];
      for (var i = 0; i < radios.length; i += 1) {
        if (radios[i].checked) {
          return true;
        }
      }
      return false;
    }

    return String(field.value || "").trim().length > 0;
  };

  Voice2Form.prototype.findLabelText = function (form, field) {
    if (field.id) {
      var byFor = form.querySelector("label[for='" + this.escapeSelectorValue(field.id) + "']");
      if (byFor) {
        return byFor.textContent.trim();
      }
    }

    var wrapped = field.closest("label");
    if (wrapped) {
      return wrapped.textContent.trim();
    }

    return "";
  };

  Voice2Form.prototype.mapTranscriptToFields = async function (transcript, schema, extraContext) {
    var payload = {
      model: this.options.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: this.options.systemPrompt,
        },
        {
          role: "user",
          content:
            "User said: " +
            transcript +
            "\\n\\nForm schema: " +
            JSON.stringify(schema) +
            (extraContext ? "\\n\\nContext: " + extraContext : "") +
            "\\n\\nReturn strict JSON only.",
        },
      ],
    };

    var response = await fetch(this.options.backendUrl + this.options.openAIPath, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error("Backend request failed with status " + response.status);
    }

    var data = await response.json();
    var content =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "{}";

    var parsed = this.parseAssistantJson(content);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid model response");
    }

    return parsed;
  };

  Voice2Form.prototype.parseAssistantJson = function (content) {
    var cleaned = String(content || "").trim();
    if (cleaned.indexOf("```") === 0) {
      cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
    }
    return JSON.parse(cleaned || "{}");
  };

  Voice2Form.prototype.applyFields = function (form, fieldMap) {
    var keys = Object.keys(fieldMap || {});

    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var value = fieldMap[key];
      var byName = this.getByNameAll(form, key);

      if (byName.length > 1 && byName[0].type && byName[0].type.toLowerCase() === "radio") {
        for (var r = 0; r < byName.length; r += 1) {
          this.setFieldValue(byName[r], value);
        }
        continue;
      }

      var candidate = byName[0] || this.getById(form, key);

      if (!candidate) {
        continue;
      }

      this.setFieldValue(candidate, value);
    }
  };

  Voice2Form.prototype.setFieldValue = function (field, value) {
    var type = (field.type || "").toLowerCase();

    if (type === "checkbox") {
      field.checked = Boolean(value);
    } else if (type === "radio") {
      field.checked = String(field.value) === String(value);
    } else if (field.tagName.toLowerCase() === "select") {
      field.value = String(value);
    } else {
      field.value = value == null ? "" : String(value);
    }

    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };

  Voice2Form.prototype.escapeSelectorValue = function (value) {
    var stringValue = String(value == null ? "" : value);
    if (typeof global.CSS !== "undefined" && typeof global.CSS.escape === "function") {
      return global.CSS.escape(stringValue);
    }
    return stringValue.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  };

  Voice2Form.prototype.getByNameAll = function (form, name, prefixSelector) {
    var escapedName = this.escapeSelectorValue(name);
    var selector = (prefixSelector ? prefixSelector : "") + "[name='" + escapedName + "']";
    return form.querySelectorAll(selector);
  };

  Voice2Form.prototype.getByName = function (form, name) {
    var nodes = this.getByNameAll(form, name);
    return nodes[0] || null;
  };

  Voice2Form.prototype.getById = function (form, id) {
    return form.querySelector("#" + this.escapeSelectorValue(id));
  };

  Voice2Form.prototype.speak = async function (text) {
    if (!text) {
      return;
    }

    if (this.options.speakWithBackend) {
      try {
        await this.speakWithBackend(text);
        return;
      } catch (error) {
        // Fall through to browser TTS.
      }
    }

    this.speakWithBrowser(text);
  };

  Voice2Form.prototype.speakWithBrowser = function (text) {
    if (!("speechSynthesis" in global)) {
      return;
    }

    var utterance = new SpeechSynthesisUtterance(String(text));
    utterance.lang = this.options.language;
    global.speechSynthesis.speak(utterance);
  };

  Voice2Form.prototype.speakWithBackend = async function (text) {
    var response = await fetch(this.options.backendUrl + this.options.ttsPath, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({
        model: this.options.ttsModel,
        input: String(text),
      }),
    });

    if (!response.ok) {
      throw new Error("TTS request failed with status " + response.status);
    }

    var audioBlob = await response.blob();
    if (!audioBlob || !audioBlob.size) {
      throw new Error("Empty audio response");
    }

    var audioUrl = URL.createObjectURL(audioBlob);
    var audio = new Audio(audioUrl);

    try {
      await audio.play();
    } catch (error) {
      throw new Error("Failed to play audio response.");
    } finally {
      URL.revokeObjectURL(audioUrl);
    }
  };

  global.Voice2Form = Voice2Form;
})(typeof window !== "undefined" ? window : globalThis);

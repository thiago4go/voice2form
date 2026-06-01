(function (global) {
  function Voice2Form(options) {
    if (!options || !options.backendUrl) {
      throw new Error("voice2form requires a backendUrl");
    }

    this.options = {
      backendUrl: options.backendUrl.replace(/\/$/, ""),
      apiKey: options.apiKey || "",
      model: options.model || "gpt-4o-mini",
      selector: options.selector || "form",
      openAIPath: options.openAIPath || "/v1/chat/completions",
      autoInit: options.autoInit !== false,
      speak: options.speak !== false,
      buttonLabel: options.buttonLabel || "🎤 Voice fill",
      systemPrompt:
        options.systemPrompt ||
        "You are a form-filling assistant. Return only JSON with {fields, reply}. fields is an object where each key is a form field name and each value is the text value to set.",
    };

    this.recognition = null;
    this.supportsSpeechRecognition =
      typeof global !== "undefined" &&
      ("SpeechRecognition" in global || "webkitSpeechRecognition" in global);

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

    var button = document.createElement("button");
    button.type = "button";
    button.textContent = this.options.buttonLabel;
    button.style.margin = "8px 0";

    var status = document.createElement("div");
    status.setAttribute("aria-live", "polite");
    status.style.fontSize = "12px";
    status.style.marginTop = "4px";

    var self = this;
    button.addEventListener("click", function () {
      self.start(form, status);
    });

    form.appendChild(button);
    form.appendChild(status);
    form.dataset.voice2formAttached = "true";
  };

  Voice2Form.prototype.start = async function (form, statusNode) {
    if (!this.supportsSpeechRecognition) {
      this.updateStatus(statusNode, "Speech recognition is not supported in this browser.");
      return;
    }

    this.updateStatus(statusNode, "Listening...");

    try {
      var transcript = await this.listenOnce();
      this.updateStatus(statusNode, "Thinking...");

      var schema = this.getFormSchema(form);
      var result = await this.mapTranscriptToFields(transcript, schema);

      this.applyFields(form, result.fields || {});
      this.updateStatus(statusNode, "Done.");

      if (this.options.speak && result.reply) {
        this.speak(result.reply);
      }
    } catch (error) {
      this.updateStatus(statusNode, "Error: " + error.message);
    }
  };

  Voice2Form.prototype.updateStatus = function (node, text) {
    if (node) {
      node.textContent = text;
    }
  };

  Voice2Form.prototype.listenOnce = function () {
    var Recognition = global.SpeechRecognition || global.webkitSpeechRecognition;
    var recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    return new Promise(function (resolve, reject) {
      recognition.onresult = function (event) {
        var transcript = event.results[0][0].transcript;
        resolve(transcript);
      };
      recognition.onerror = function (event) {
        reject(new Error(event.error || "Speech recognition failed"));
      };
      recognition.onnomatch = function () {
        reject(new Error("No speech recognized"));
      };
      recognition.start();
    });
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

  Voice2Form.prototype.findLabelText = function (form, field) {
    if (field.id) {
      var byFor = form.querySelector("label[for='" + field.id + "']");
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

  Voice2Form.prototype.mapTranscriptToFields = async function (transcript, schema) {
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
            "\\n\\nReturn strict JSON only.",
        },
      ],
    };

    var response = await fetch(this.options.backendUrl + this.options.openAIPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.options.apiKey ? "Bearer " + this.options.apiKey : "",
      },
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
      var candidate =
        form.querySelector("[name='" + key + "']") || form.querySelector("#" + key);

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

  Voice2Form.prototype.speak = function (text) {
    if (!("speechSynthesis" in global)) {
      return;
    }

    var utterance = new SpeechSynthesisUtterance(String(text));
    global.speechSynthesis.speak(utterance);
  };

  global.Voice2Form = Voice2Form;
})(typeof window !== "undefined" ? window : globalThis);

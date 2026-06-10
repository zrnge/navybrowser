// llm.js — Local and Cloud LLM client.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

function assertLoopback(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(`LLM endpoint ${url} is not loopback. Privacy-first build refuses to call non-local endpoints.`);
    }
  } catch (e) {
    if (e.message.includes("is not loopback")) throw e;
  }
}

export function extractJson(raw) {
  raw = raw.trim();
  const candidates = [];

  function ingest(text) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object') {
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              candidates.push(item);
            }
          }
        } else {
          candidates.push(obj);
        }
      }
    } catch (_) {}
  }

  // 1. Direct parse
  ingest(raw);

  // 2. Fenced code blocks
  const fenceRegex = /```(?:json)?\s*(\{.*?\})\s*```/gs;
  let match;
  while ((match = fenceRegex.exec(raw)) !== null) {
    ingest(match[1]);
  }

  // 3. Balanced { } spans
  let pos = 0;
  while (pos < raw.length) {
    const start = raw.indexOf("{", pos);
    if (start === -1) break;
    let depth = 0;
    let end = start;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === "{") {
        depth++;
      } else if (raw[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (depth === 0) {
      ingest(raw.substring(start, end + 1));
      pos = end + 1;
    } else {
      break; // unbalanced
    }
  }

  if (candidates.length === 0) {
    throw new Error("no JSON object found in response");
  }

  // Prefer AgentStep format
  for (const c of candidates) {
    if ("thought" in c && "action" in c) {
      return c;
    }
  }

  return candidates[0];
}

export class LocalLLM {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || "http://127.0.0.1:11434/v1";
    this.model = config.model || "minicpm-v:8b";
    this.temperature = config.temperature !== undefined ? config.temperature : 0.2;
    this.maxTokens = config.maxTokens || 2048;
    this.jsonMode = config.jsonMode || false;
    this.anthropicKey = config.anthropicKey || null;

    if (!this.anthropicKey) {
      assertLoopback(this.baseUrl);
    }
  }

  async chat(system, user, images = null) {
    if (this.anthropicKey) {
      return this.chatAnthropic(system, user, images);
    }

    const messages = [{ role: "system", content: system }];
    if (images && images.length > 0) {
      const content = [{ type: "text", text: user }];
      for (const img of images) {
        content.push({
          type: "image_url",
          image_url: { url: img }
        });
      }
      messages.push({ role: "user", content });
    } else {
      messages.push({ role: "user", content: user });
    }

    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens
    };

    if (this.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`LLM server HTTP ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    if (!data.choices || data.choices.length === 0) {
      throw new Error("LLM response has empty choices");
    }
    return data.choices[0].message.content;
  }

  async chatAnthropic(system, user, images = null) {
    const messages = [];
    const content = [];

    if (images && images.length > 0) {
      for (const imgUrl of images) {
        const m = imgUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (m) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: m[1],
              data: m[2]
            }
          });
        }
      }
    }
    content.push({ type: "text", text: user });
    messages.push({ role: "user", content });

    const body = {
      model: this.model || "claude-3-5-sonnet-latest",
      messages,
      system,
      max_tokens: this.maxTokens,
      temperature: this.temperature
    };

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "dangerously-allow-developer-ui-requests": "true",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    if (!data.content || data.content.length === 0) {
      throw new Error("Anthropic response has empty content");
    }
    return data.content[0].text;
  }

  async planStep(system, user, screenshotB64 = null) {
    const images = screenshotB64 ? [`data:image/jpeg;base64,{screenshotB64}`.replace("{screenshotB64}", screenshotB64)] : null;
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      let prompt = user;
      if (lastError && attempt > 0) {
        prompt = `${user}\n\nPREVIOUS RESPONSE WAS REJECTED. You must output EXACTLY this structure:\n` +
          `{"thought": "one sentence", "action": {"type": "click", "som_id": 5, "reasoning": "Submit — SoM #5"}}\n` +
          `For click/double_click/right_click/hover: som_id is the RED NUMBER shown on the element in the screenshot.\n` +
          `Only use x,y if the element has NO red label: {"type":"click","x":320,"y":250,"reasoning":"..."}\n` +
          `For type: {"type":"type","ref":"14389","text":"hello","reasoning":"..."}\n` +
          `Valid action types: click, double_click, right_click, hover, type, scroll, navigate, new_tab, key, read, wait, script, done, ask_user, remember, abort\n` +
          `Rejection reason: ${lastError}\n` +
          `Output ONLY the JSON object — no prose, no arrays, no extra keys.`;
      }

      const raw = await this.chat(system, prompt, images);
      try {
        const obj = extractJson(raw);
        if (!obj.thought) throw new Error("Missing 'thought' field in JSON");
        if (!obj.action || !obj.action.type) throw new Error("Missing 'action' or 'action.type' field in JSON");

        const actType = obj.action.type;

        // Autonomous execution constraints:
        if (actType === "ask_user") {
          const goalMatch = user.match(/<USER_GOAL>([\s\S]*?)<\/USER_GOAL>/);
          const urlMatch = user.match(/<CURRENT_URL>([\s\S]*?)<\/CURRENT_URL>/);

          const goalRaw = goalMatch ? goalMatch[1].trim() : "";
          const goal = goalRaw.toLowerCase();
          const url = urlMatch ? urlMatch[1].trim().toLowerCase() : "";

          // 1. Challenge/CTF goals ban
          const isChallengeGoal = ["solve", "do this", "challenge", "ctf", "room", "tryhackme", "hackthebox"].some(w => goal.includes(w));
          const isChallengeUrl = ["tryhackme.com", "hackthebox.com", "hackthebox.eu"].some(w => url.includes(w));
          if (isChallengeGoal || isChallengeUrl) {
            throw new Error(
              "The 'ask_user' action is STRICTLY PROHIBITED for challenges, TryHackMe/HackTheBox, or generic 'solve this' goals. " +
              "You must proceed completely autonomously. Use 'read' to extract page content, navigate/scroll to explore, or emit 'done' with your findings."
            );
          }

          // 2. Already quoted data ban
          const quotedInGoal = goalRaw.match(/["']([^"']{3,})["']/g);
          if (quotedInGoal) {
            const question = (obj.action.question || "").toLowerCase();
            const askingForData = /\b(what|provide|give|enter|specify|tell)\b[\s\S]{0,40}\b(text|string|input|data|value|content|message|code|hash|cipher|encrypt|decrypt)\b/.test(question);
            if (askingForData) {
              throw new Error(
                `The goal already contains the data you need: ${quotedInGoal.join(", ")}. ` +
                "Extract it from the <USER_GOAL> and use it directly — do NOT ask the user for it. " +
                "Your next action must be navigate/type/click using that value."
              );
            }
          }
        }

        // Read repetition ban
        if (actType === "read" && user.includes("!! READ COMPLETE")) {
          throw new Error(
            "read was already completed on this page — repeating it returns the same data. " +
            "You MUST either: (1) emit 'done' with the content you already extracted, " +
            "or (2) take a different action (click, type, navigate, script) to change the page state. " +
            "Example done: {\"type\": \"done\", \"summary\": \"Page content extracted.\", \"result\": \"<paste the extracted text>\"}"
          );
        }

        // Escalation checks
        if (actType === "click") {
          const proposedRef = obj.action.ref;
          const proposedX = obj.action.x;
          const proposedY = obj.action.y;

          if (proposedRef && user.includes(`!! ESCALATION[ref:${proposedRef}]`)) {
            throw new Error(
              `ref:${proposedRef} already failed single click (page did not change). ` +
              "You MUST escalate — use double_click, drag, or right_click instead. " +
              `Example: {"type": "double_click", "ref": "${proposedRef}", "reasoning": "escalate from failed single click"}`
            );
          }
          if (proposedX !== undefined && proposedY !== undefined) {
            const coordTag = `x:${proposedX},y:${proposedY}`;
            if (user.includes(`!! ESCALATION[${coordTag}]`)) {
              throw new Error(
                `Coordinate click at (${proposedX},${proposedY}) already failed. ` +
                "You MUST escalate — use double_click, drag, or right_click at these coords instead. " +
                `Example: {"type": "double_click", "x": ${proposedX}, "y": ${proposedY}, "reasoning": "escalate from failed single click"}`
              );
            }
          }
        }

        if (actType === "double_click") {
          const proposedRef = obj.action.ref;
          const proposedX = obj.action.x;
          const proposedY = obj.action.y;

          if (proposedRef && user.includes(`!! ESCALATION2[ref:${proposedRef}]`)) {
            throw new Error(
              `ref:${proposedRef} failed both single click AND double_click (page did not change). ` +
              "STOP clicking this element. You MUST try something completely different: " +
              "drag, right_click, or look for DIFFERENT elements. " +
              "If you typed in a search box, look for NEW result items in the accessibility tree (listitem/option/treeitem/menuitem). " +
              `Example: {"type": "drag", "from_ref": "${proposedRef}", "to_x": 700, "to_y": 400, "reasoning": "escalate from failed double_click"}`
            );
          }
          if (proposedX !== undefined && proposedY !== undefined) {
            const coordTag = `x:${proposedX},y:${proposedY}`;
            if (user.includes(`!! ESCALATION2[${coordTag}]`)) {
              throw new Error(
                `Coordinate (${proposedX},${proposedY}) failed both click and double_click. ` +
                "Try drag, right_click, or a completely different element."
              );
            }
          }
        }

        return obj;
      } catch (e) {
        lastError = e.message.substring(0, 500);
        console.warn(`LLM step ${attempt} failed validation: ${lastError}`);
      }
    }
    throw new Error(`LLM produced invalid AgentStep after 3 tries: ${lastError}`);
  }
}

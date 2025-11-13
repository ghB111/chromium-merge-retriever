const uploadForm = document.getElementById("uploadForm");
const fileInput = document.getElementById("fileInput");
const uploadSection = document.getElementById("uploadSection");
const chatSection = document.getElementById("chatSection");
const chatWindow = document.getElementById("chatWindow");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const chatStatus = document.getElementById("chatStatus");
const template = document.getElementById("messageTemplate");

let chatId = null;
let isUploading = false;
let isSending = false;

const createMessageElement = (role, content, sources = []) => {
  const clone = template.content.cloneNode(true);
  const roleEl = clone.querySelector(".message__role");
  const contentEl = clone.querySelector(".message__content");
  const sourcesEl = clone.querySelector(".message__sources");

  roleEl.textContent = role;
  contentEl.textContent = content;

  sourcesEl.innerHTML = "";
  if (sources.length) {
    sourcesEl.innerHTML = sources
      .map((source) => {
        const label = `${source.commit.slice(0, 12)}...`;
        return `<a href="${source.commit_url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      })
      .join(" ");
  }

  return clone;
};

const appendMessage = (role, content, sources = []) => {
  chatWindow.appendChild(createMessageElement(role, content, sources));
  chatWindow.scrollTop = chatWindow.scrollHeight;
};

const setStatus = (text) => {
  chatStatus.textContent = text;
};

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isUploading) return;

  const file = fileInput.files[0];
  if (!file) {
    alert("Please choose a JSON file to upload.");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    isUploading = true;
    setStatus("Uploading changelog...");
    uploadForm.querySelector("button").disabled = true;

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Upload failed");
    }

    const data = await response.json();
    chatId = data.chat_id;
    setStatus(`Chat ready with ${data.commit_count} commits indexed.`);
    chatSection.classList.remove("hidden");
    uploadSection.classList.add("hidden");
    appendMessage("system", "Ask anything about the uploaded Chromium changelog.");
    messageInput.focus();
  } catch (error) {
    console.error(error);
    alert(error.message || "Upload failed. Please try again.");
    setStatus("");
  } finally {
    isUploading = false;
    uploadForm.querySelector("button").disabled = false;
    uploadForm.reset();
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!chatId || isSending) return;

  const message = messageInput.value.trim();
  if (!message) return;

  appendMessage("you", message);
  messageInput.value = "";
  messageInput.style.height = "auto";

  try {
    isSending = true;
    setStatus("Thinking...");
    chatForm.querySelector("button").disabled = true;

    const response = await fetch(`/api/chat/${chatId}/question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Unable to get an answer.");
    }

    const data = await response.json();
    appendMessage("assistant", data.answer, data.sources || []);
    setStatus("Ask another question or upload a new changelog.");
  } catch (error) {
    console.error(error);
    appendMessage("system", error.message || "Something went wrong.");
    setStatus("Encountered an error while answering.");
  } finally {
    isSending = false;
    chatForm.querySelector("button").disabled = false;
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
});

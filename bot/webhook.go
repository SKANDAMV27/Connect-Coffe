package main

import (
	"bytes"
	"connect-coffee-bot/db"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
)

// maxWebhookBody caps what will be read from a POST, so an oversized or
// endless body cannot be pulled into memory.
const maxWebhookBody = 1 << 20 // 1 MiB

// verifyMetaSignature checks the X-Hub-Signature-256 header Meta sends with
// every webhook delivery, computed over the raw body with the app secret.
//
// This was not checked at all. The endpoint is public by necessity, so without
// it anybody who learned the URL could post whatever they liked: fabricate
// inbound messages, create leads, and make the bot send WhatsApp messages to
// numbers of their choosing on the business account.
func verifyMetaSignature(body []byte, header string) bool {
	appSecret := os.Getenv("META_APP_SECRET")
	if appSecret == "" {
		// Only tolerated outside production; main refuses to boot without it
		// when ENV is production.
		if isProduction() {
			return false
		}
		log.Println("⚠️  META_APP_SECRET is not set — webhook signatures are NOT being verified")
		return true
	}

	const prefix = "sha256="
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	want, err := hex.DecodeString(strings.TrimPrefix(header, prefix))
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, []byte(appSecret))
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), want)
}

type WebhookRequest struct {
	Entry []struct {
		Changes []struct {
			Value struct {
				// Which of the business's numbers the message was sent to.
				Metadata struct {
					PhoneNumberID string `json:"phone_number_id"`
				} `json:"metadata"`
				Contacts []struct {
					Profile struct {
						Name string `json:"name"`
					} `json:"profile"`
					WaID string `json:"wa_id"`
				} `json:"contacts"`
				Messages []struct {
					ID   string `json:"id"`
					From string `json:"from"`
					Type string `json:"type"`
					Text *struct {
						Body string `json:"body"`
					} `json:"text,omitempty"`
					// A tap on a template's quick-reply button.
					Button *struct {
						Payload string `json:"payload"`
						Text    string `json:"text"`
					} `json:"button,omitempty"`
					Interactive *struct {
						ButtonReply struct {
							ID    string `json:"id"`
							Title string `json:"title"`
						} `json:"button_reply"`
					} `json:"interactive,omitempty"`
					Location *struct {
						Latitude  float64 `json:"latitude"`
						Longitude float64 `json:"longitude"`
					} `json:"location,omitempty"`
					Image *struct {
						ID      string `json:"id"`
						Caption string `json:"caption"`
					} `json:"image,omitempty"`
					Document *struct {
						ID       string `json:"id"`
						Filename string `json:"filename"`
					} `json:"document,omitempty"`
				} `json:"messages"`
				Statuses []struct {
					ID     string `json:"id"`
					Status string `json:"status"`
					Errors []struct {
						Code      int    `json:"code"`
						Title     string `json:"title"`
						Message   string `json:"message"`
						ErrorData struct {
							Details string `json:"details"`
						} `json:"error_data"`
					} `json:"errors,omitempty"`
				} `json:"statuses,omitempty"`
			} `json:"value"`
		} `json:"changes"`
	} `json:"entry"`
}

func WebhookHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		verifyToken := os.Getenv("VERIFY_TOKEN")
		mode := r.URL.Query().Get("hub.mode")
		token := r.URL.Query().Get("hub.verify_token")
		challenge := r.URL.Query().Get("hub.challenge")

		if mode == "subscribe" && constantTimeEqual(token, verifyToken) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(challenge))
			return
		}
		w.WriteHeader(http.StatusForbidden)
		return
	}

	if r.Method == http.MethodPost {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBody))
		if err != nil {
			log.Printf("[Webhook] Could not read the request body: %v", err)
			w.WriteHeader(http.StatusOK) // Always return 200 so Meta stops retrying
			return
		}

		if !verifyMetaSignature(body, r.Header.Get("X-Hub-Signature-256")) {
			log.Println("⚠️  [Webhook] Rejected a delivery with a missing or invalid signature")
			w.WriteHeader(http.StatusForbidden)
			return
		}

		var req WebhookRequest
		if err := json.NewDecoder(bytes.NewReader(body)).Decode(&req); err != nil {
			w.WriteHeader(http.StatusOK) // Always return 200
			return
		}

		for _, entry := range req.Entry {
			for _, change := range entry.Changes {
				// One Meta app can be subscribed to several WhatsApp
				// accounts, and delivers every one's messages to the same
				// webhook. Answer only what was sent to this bot's number,
				// or it would reply on another business's behalf.
				if own, to := os.Getenv("PHONE_NUMBER_ID"), change.Value.Metadata.PhoneNumberID; own != "" && to != "" && to != own {
					log.Printf("[Webhook] Ignoring a delivery for phone number %s, which is not this bot's", to)
					continue
				}

				// 1. Save contact names from profile
				for _, contact := range change.Value.Contacts {
					db.SaveContact(contact.WaID, contact.Profile.Name)
				}

				// 2. Process messages
				for _, msg := range change.Value.Messages {
					phone := msg.From
					text := ""
					var lat, lng float64

					if msg.Type == "location" && msg.Location != nil {
						lat = msg.Location.Latitude
						lng = msg.Location.Longitude
						text = "LOCATION_DATA"
					} else if msg.Type == "image" && msg.Image != nil {
						text = "[IMAGE_RECEIVED]"
						if msg.Image.Caption != "" {
							text += ": " + msg.Image.Caption
						}
					} else if msg.Type == "document" && msg.Document != nil {
						text = "[DOCUMENT_RECEIVED]"
						if msg.Document.Filename != "" {
							text += ": " + msg.Document.Filename
						}
					} else if msg.Text != nil {
						text = msg.Text.Body
					} else if msg.Interactive != nil {
						text = msg.Interactive.ButtonReply.ID
					} else if msg.Button != nil {
						// The payload is the action the broadcaster gave the
						// button; without one, the button's own words.
						text = msg.Button.Payload
						if text == "" {
							text = msg.Button.Text
						}
					} else {
						text = "[" + strings.ToUpper(msg.Type) + "_RECEIVED]"
					}

					if text != "" {
						// Only the delivery that actually stored the message
						// gets to act on it. Meta sends each one twice.
						fresh, err := db.LogIncomingMessage(phone, text, msg.ID)
						if err != nil {
							log.Printf("[Webhook] Could not log a message from %s: %v", phone, err)
							continue
						}
						if !fresh {
							log.Printf("[Webhook] Ignoring a repeat delivery of %s from %s", msg.ID, phone)
							continue
						}

						log.Printf("[Webhook] Incoming from %s: %s", phone, text)
						go handleMessage(phone, text, lat, lng)
					}
				}

				// 3. Process delivery statuses. Broadcast sends are matched
				// back to their recipient row for the delivery report.
				for _, status := range change.Value.Statuses {
					code, reason := 0, ""
					if status.Status == "failed" && len(status.Errors) > 0 {
						errStr := ""
						for _, e := range status.Errors {
							errStr += e.Message + " "
						}
						log.Printf("⚠️ [Webhook] Message Delivery FAILED (ID: %s) - Reason: %s", status.ID, errStr)
						e := status.Errors[0]
						code, reason = e.Code, e.Message
						if reason == "" {
							reason = e.ErrorData.Details
						}
						if reason == "" {
							reason = e.Title
						}
					}
					switch status.Status {
					case "sent", "delivered", "read", "failed":
						if err := db.UpdateRecipientStatus(status.ID, status.Status, code, reason); err != nil {
							log.Printf("[Webhook] Could not record status %s for %s: %v", status.Status, status.ID, err)
						}
					}
				}
			}
		}

		w.WriteHeader(http.StatusOK)
		return
	}
}

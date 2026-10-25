package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"connect-coffee-bot/db"
)

// One shared client, so connections are pooled and every call is bounded.
var metaClient = &http.Client{Timeout: 20 * time.Second}

type Button struct {
	ID    string
	Title string
}

func sendTextMessage(to, message string) {
	payload := map[string]interface{}{
		"messaging_product": "whatsapp",
		"to":                to,
		"type":              "text",
		"text": map[string]string{
			"body": message,
		},
	}
	sendToMeta(payload, to, message)
}

func sendImage(to, imageURL, caption string) {
	payload := map[string]interface{}{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "image",
		"image": map[string]string{
			"link":    imageURL,
			"caption": caption,
		},
	}
	sendToMeta(payload, to, "[Image: "+imageURL+"] "+caption)
}

func sendInteractiveButtons(to, bodyText string, buttons []Button) {
	var waButtons []map[string]interface{}
	for _, b := range buttons {
		// Ensure title is max 20 chars
		title := b.Title
		if len([]rune(title)) > 20 {
			title = string([]rune(title)[:17]) + "..."
		}

		waButtons = append(waButtons, map[string]interface{}{
			"type": "reply",
			"reply": map[string]string{
				"id":    b.ID,
				"title": title,
			},
		})
	}

	payload := map[string]interface{}{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "interactive",
		"interactive": map[string]interface{}{
			"type": "button",
			"body": map[string]string{
				"text": bodyText,
			},
			"action": map[string]interface{}{
				"buttons": waButtons,
			},
		},
	}
	sendToMeta(payload, to, bodyText)
}

func sendImageWithButtons(to, imageURL, bodyText string, buttons []Button) bool {
	return sendImageWithButtonsResult(to, imageURL, bodyText, buttons).OK()
}

// sendImageWithButtonsResult is sendImageWithButtons for a broadcast, which
// keeps Meta's message ID to follow the delivery.
func sendImageWithButtonsResult(to, imageURL, bodyText string, buttons []Button) metaResult {
	header := map[string]interface{}{
		"type":  "image",
		"image": map[string]string{"link": imageURL},
	}
	return sendButtonsWithHeader(to, header, bodyText, buttons, "[Image: "+imageURL+"] "+bodyText)
}

// sendDocumentWithButtons puts a file, such as the menu PDF, on top of a
// button message. One message keeps the file ahead of the text; sent
// separately, the text often arrives first because Meta fetches the file.
func sendDocumentWithButtons(to, docURL, filename, bodyText string, buttons []Button) {
	header := map[string]interface{}{
		"type":     "document",
		"document": map[string]string{"link": docURL, "filename": filename},
	}
	sendButtonsWithHeader(to, header, bodyText, buttons, "[Document: "+docURL+"] "+bodyText)
}

func sendButtonsWithHeader(to string, header map[string]interface{}, bodyText string, buttons []Button, logMsg string) metaResult {
	var waButtons []map[string]interface{}
	for _, b := range buttons {
		title := b.Title
		if len([]rune(title)) > 20 {
			title = string([]rune(title)[:17]) + "..."
		}

		waButtons = append(waButtons, map[string]interface{}{
			"type": "reply",
			"reply": map[string]string{
				"id":    b.ID,
				"title": title,
			},
		})
	}

	payload := map[string]interface{}{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "interactive",
		"interactive": map[string]interface{}{
			"type":   "button",
			"header": header,
			"body": map[string]string{
				"text": bodyText,
			},
			"action": map[string]interface{}{
				"buttons": waButtons,
			},
		},
	}
	return sendToMetaResult(payload, to, logMsg)
}

// sendLocation sends a map pin the customer can tap to navigate.
func sendLocation(to string, lat, lng float64, name, address string) {
	payload := map[string]interface{}{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "location",
		"location": map[string]interface{}{
			"latitude":  lat,
			"longitude": lng,
			"name":      name,
			"address":   address,
		},
	}
	sendToMeta(payload, to, fmt.Sprintf("[Location: %s]", name))
}

// metaResult is Meta's answer to one send: the message ID it accepted the
// message under, or why it refused it.
type metaResult struct {
	ID        string
	ErrorCode int
	Error     string
}

func (r metaResult) OK() bool { return r.ID != "" }

// sendToMeta reports whether Meta accepted the message.
func sendToMeta(payload map[string]interface{}, to, logMsg string) bool {
	return sendToMetaResult(payload, to, logMsg).OK()
}

func sendToMetaResult(payload map[string]interface{}, to, logMsg string) metaResult {
	url := fmt.Sprintf("https://graph.facebook.com/v17.0/%s/messages", os.Getenv("PHONE_NUMBER_ID"))
	token := os.Getenv("ACCESS_TOKEN")

	// Dry run: with no Meta credentials outside production, log what would
	// have been sent and record it, so the whole bot and the panel can be
	// tried locally before a WhatsApp number is connected.
	if token == "" && !isProduction() {
		jsonPayload, _ := json.Marshal(payload)
		log.Printf("🧪 [dry-run] to %s: %s\n", to, string(jsonPayload))
		id := fmt.Sprintf("dry-run-%d", time.Now().UnixNano())
		db.LogMessage(to, "outgoing", logMsg)
		return metaResult{ID: id}
	}

	// Normalize phone number for Meta (must include country code, no +, no spaces)
	normalizedTo := strings.ReplaceAll(to, "+", "")
	normalizedTo = strings.ReplaceAll(normalizedTo, " ", "")
	if len(normalizedTo) == 10 {
		normalizedTo = "91" + normalizedTo
	}
	payload["to"] = normalizedTo

	jsonPayload, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(jsonPayload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	// Without a timeout a hung connection to Meta blocks this goroutine for
	// ever, and since handleMessage holds stateMu across its sends, it would
	// block every other conversation with it.
	resp, err := metaClient.Do(req)
	if err != nil {
		log.Println("Error sending to Meta:", err)
		return metaResult{Error: "Could not reach WhatsApp: " + err.Error()}
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var answer struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
		Error struct {
			Code      int    `json:"code"`
			Message   string `json:"message"`
			ErrorData struct {
				Details string `json:"details"`
			} `json:"error_data"`
		} `json:"error"`
	}
	json.Unmarshal(bodyBytes, &answer)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("❌ Meta API Error (Status %d): %s\n", resp.StatusCode, string(bodyBytes))
		log.Printf("❌ Failed Payload: %s\n", string(jsonPayload))
		reason := answer.Error.ErrorData.Details
		if reason == "" {
			reason = answer.Error.Message
		}
		if reason == "" {
			reason = fmt.Sprintf("WhatsApp refused the message (HTTP %d)", resp.StatusCode)
		}
		return metaResult{ErrorCode: answer.Error.Code, Error: reason}
	}

	id := ""
	if len(answer.Messages) > 0 {
		id = answer.Messages[0].ID
	}
	if id == "" {
		// Accepted, but with no ID to follow it by. Still a send.
		id = fmt.Sprintf("unknown-%d", time.Now().UnixNano())
	}
	db.LogMessage(to, "outgoing", logMsg)
	log.Printf("✅ Meta Success! Message sent to %s: %s\n", to, logMsg)
	return metaResult{ID: id}
}

func createCleanID(text string) string {
	var parts []string
	curr := ""
	for _, r := range strings.ToLower(text) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			curr += string(r)
		} else if len(curr) > 0 {
			parts = append(parts, curr)
			curr = ""
		}
	}
	if curr != "" {
		parts = append(parts, curr)
	}
	res := strings.Join(parts, "_")
	if res == "" {
		return "btn"
	}
	return res
}

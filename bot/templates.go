package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"connect-coffee-bot/db"

	"github.com/go-chi/chi/v5"
)

// WhatsApp only delivers a free-form message to someone who wrote in the last
// 24 hours. Everyone else can be reached only with a template Meta approved
// in advance, and Meta charges for each one delivered. An offer can name a
// marketing template; the broadcaster sends it to subscribed contacts outside
// the window, with the offer's photo as the template's image header.

// MetaTemplate is a message template as Meta's API describes it.
type MetaTemplate struct {
	ID             string              `json:"id"`
	Name           string              `json:"name"`
	Language       string              `json:"language"`
	Category       string              `json:"category"`
	Status         string              `json:"status"`
	RejectedReason string              `json:"rejected_reason"`
	Components     []TemplateComponent `json:"components"`
}

type TemplateComponent struct {
	Type    string           `json:"type"`   // HEADER | BODY | FOOTER | BUTTONS
	Format  string           `json:"format"` // header only: TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION
	Text    string           `json:"text"`
	Buttons []TemplateButton `json:"buttons"`
	// The sample Meta's reviewers saw; for an image header, a link to it.
	Example *struct {
		HeaderHandle []string `json:"header_handle"`
	} `json:"example,omitempty"`
}

type TemplateButton struct {
	Type string `json:"type"` // QUICK_REPLY | URL | PHONE_NUMBER | ...
	Text string `json:"text"`
	URL  string `json:"url"`
}

// templateProblem returns why the broadcaster cannot send t, or "" if it can.
// It fills in only the image header and quick-reply payloads, so a template
// that needs text filled in ({{1}}) or another kind of header is refused when
// the offer is saved rather than failing for every contact at send time.
func templateProblem(t MetaTemplate) string {
	if t.Status != "APPROVED" {
		return "it is not approved by Meta yet"
	}
	if t.Category != "MARKETING" {
		return "it is not a marketing template"
	}
	for _, c := range t.Components {
		switch c.Type {
		case "HEADER":
			if c.Format != "IMAGE" && c.Format != "TEXT" {
				return "its header must be an image or plain text"
			}
		case "BUTTONS":
			for _, b := range c.Buttons {
				if b.Type == "URL" && strings.Contains(b.URL, "{{") {
					return "its link button needs a value filled in"
				}
			}
		}
		if strings.Contains(c.Text, "{{") {
			return "its text has {{ }} values to fill in; use one without them"
		}
	}
	return ""
}

func (t MetaTemplate) component(kind string) (TemplateComponent, bool) {
	for _, c := range t.Components {
		if c.Type == kind {
			return c, true
		}
	}
	return TemplateComponent{}, false
}

// The list barely changes, and the composer reads it each time it opens.
var templateCache struct {
	sync.Mutex
	list    []MetaTemplate
	fetched time.Time
}

const templateCacheFor = 2 * time.Minute

// fetchTemplates returns the business account's marketing templates. It
// needs WABA_ID: templates belong to the WhatsApp Business Account, not to
// the phone number.
func fetchTemplates() ([]MetaTemplate, error) {
	templateCache.Lock()
	defer templateCache.Unlock()
	if templateCache.list != nil && time.Since(templateCache.fetched) < templateCacheFor {
		return templateCache.list, nil
	}

	waba := strings.TrimSpace(os.Getenv("WABA_ID"))
	if waba == "" {
		return nil, fmt.Errorf("WABA_ID is not set, so the bot cannot read your WhatsApp templates")
	}
	q := url.Values{
		"fields":   {"id,name,language,category,status,rejected_reason,components"},
		"category": {"MARKETING"},
		"limit":    {"100"},
	}
	req, _ := http.NewRequest("GET", fmt.Sprintf("https://graph.facebook.com/v17.0/%s/message_templates?%s", waba, q.Encode()), nil)
	req.Header.Set("Authorization", "Bearer "+os.Getenv("ACCESS_TOKEN"))
	resp, err := metaClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach Meta: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("❌ [Templates] Meta answered %d: %s", resp.StatusCode, body)
		return nil, fmt.Errorf("Meta refused the template list (status %d)", resp.StatusCode)
	}

	var page struct {
		Data []MetaTemplate `json:"data"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		return nil, fmt.Errorf("could not read Meta's template list: %w", err)
	}
	templateCache.list, templateCache.fetched = page.Data, time.Now()
	return page.Data, nil
}

// findTemplate looks up one template by name and language.
func findTemplate(name, lang string) (MetaTemplate, error) {
	list, err := fetchTemplates()
	if err != nil {
		return MetaTemplate{}, err
	}
	for _, t := range list {
		if t.Name == name && t.Language == lang {
			return t, nil
		}
	}
	return MetaTemplate{}, fmt.Errorf("there is no template %q (%s) on your WhatsApp account", name, lang)
}

// What each of a template's quick-reply buttons does is set in the panel and
// kept here, not at Meta: Meta fixes only the button text, and a tap comes
// back as whatever payload the send gave it. So it can change at any time,
// even after approval.

func templateActionsKey(name string) string { return "template_actions:" + name }

// templateActions returns the action ids saved for a template's quick-reply
// buttons, in button order, or nil if none were saved.
func templateActions(name string) []string {
	var actions []string
	if raw := db.GetSetting(templateActionsKey(name)); raw != "" {
		if err := json.Unmarshal([]byte(raw), &actions); err != nil {
			log.Printf("[Templates] Saved actions for %q are unreadable: %v", name, err)
			return nil
		}
	}
	return actions
}

func saveTemplateActions(name string, actions []string) error {
	raw, _ := json.Marshal(actions)
	if len(actions) == 0 {
		raw = nil
	}
	return db.UpdateSetting(templateActionsKey(name), string(raw))
}

// quickReplyCount is how many quick-reply buttons t has.
func (t MetaTemplate) quickReplyCount() int {
	n := 0
	if b, ok := t.component("BUTTONS"); ok {
		for _, btn := range b.Buttons {
			if btn.Type == "QUICK_REPLY" {
				n++
			}
		}
	}
	return n
}

// checkTemplateActions returns why actions cannot go on a template with
// quick quick-reply buttons, or "" if they can.
func checkTemplateActions(actions []string, quick int) string {
	if len(actions) != quick {
		return "choose what each button does"
	}
	for _, a := range actions {
		if !posterButtonActions[a] {
			return fmt.Sprintf("%q is not an action the bot handles", a)
		}
	}
	return ""
}

// sendTemplate sends t to one contact and reports whether Meta accepted it.
// An image header carries the offer's photo. Quick-reply buttons carry the
// given actions in order as their payloads, so a tap does what that action
// does anywhere else in the bot.
func sendTemplate(to string, t MetaTemplate, imageURL string, actions []string) metaResult {
	payload := map[string]interface{}{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "template",
		"template":          templateMessage(t, imageURL, actions),
	}
	body := ""
	if c, ok := t.component("BODY"); ok {
		body = c.Text
	}
	return sendToMetaResult(payload, to, "[Template: "+t.Name+"] "+body)
}

// templateMessage is the "template" object of a send: the template's name and
// language, and the values its image header and quick-reply buttons take.
func templateMessage(t MetaTemplate, imageURL string, actions []string) map[string]interface{} {
	var components []map[string]interface{}
	if h, ok := t.component("HEADER"); ok && h.Format == "IMAGE" {
		components = append(components, map[string]interface{}{
			"type": "header",
			"parameters": []map[string]interface{}{
				{"type": "image", "image": map[string]string{"link": imageURL}},
			},
		})
	}
	if b, ok := t.component("BUTTONS"); ok {
		quick := 0
		for i, btn := range b.Buttons {
			if btn.Type != "QUICK_REPLY" {
				continue
			}
			if quick < len(actions) {
				components = append(components, map[string]interface{}{
					"type":     "button",
					"sub_type": "quick_reply",
					"index":    fmt.Sprint(i),
					"parameters": []map[string]string{
						{"type": "payload", "payload": actions[quick]},
					},
				})
			}
			quick++
		}
	}

	template := map[string]interface{}{
		"name":     t.Name,
		"language": map[string]string{"code": t.Language},
	}
	if len(components) > 0 {
		template["components"] = components
	}
	return template
}

// templatesHandler lists the account's marketing templates for the composer,
// each with whether the broadcaster can send it.
func templatesHandler(w http.ResponseWriter, r *http.Request) {
	type item struct {
		MetaTemplate
		Problem string   `json:"problem"`
		Actions []string `json:"actions"`
	}
	w.Header().Set("Content-Type", "application/json")

	list, err := fetchTemplates()
	if err != nil {
		// 200 with the reason: the composer shows it instead of the picker.
		json.NewEncoder(w).Encode(map[string]interface{}{"data": []item{}, "error": err.Error()})
		return
	}
	out := make([]item, 0, len(list))
	for _, t := range list {
		out = append(out, item{MetaTemplate: t, Problem: templateProblem(t), Actions: templateActions(t.Name)})
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"data": out})
}

// templateActionsHandler sets what a template's quick-reply buttons do.
func templateActionsHandler(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var body struct {
		Actions []string `json:"actions"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "Those button actions could not be read.")
		return
	}
	list, err := fetchTemplates()
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	for _, t := range list {
		if t.Name != name {
			continue
		}
		if problem := checkTemplateActions(body.Actions, t.quickReplyCount()); problem != "" {
			writeJSONError(w, http.StatusBadRequest, "Not saved: "+problem+".")
			return
		}
		if err := saveTemplateActions(name, body.Actions); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "The button actions could not be saved.")
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSONError(w, http.StatusNotFound, "There is no template with that name.")
}

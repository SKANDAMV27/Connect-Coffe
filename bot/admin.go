package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"connect-coffee-bot/db"

	"github.com/go-chi/chi/v5"
)

// retryPreview is who a retry of camp would go to if it were sent now.
func retryPreview(camp db.Campaign) (free, paid []string, err error) {
	inWindow, err := db.GetPhonesInServiceWindow()
	if err != nil {
		return nil, nil, err
	}
	return retryAudience(db.Campaign{RetryOf: camp.ID, TemplateName: camp.TemplateName}, inWindow)
}

func AdminRoutes() chi.Router {
	r := chi.NewRouter()

	r.Use(AuthMiddleware)

	// ── STATIC FILE SERVING FOR UPLOADS ──────────────────────────────────────
	uploadDir := "./uploads"
	if _, err := os.Stat(uploadDir); os.IsNotExist(err) {
		os.Mkdir(uploadDir, 0755)
	}
	// Served publicly so Meta can fetch poster images. X-Content-Type-Options
	// stops a browser sniffing one of these into something executable, and the
	// CSP is a second line behind the image-only check on the upload itself.
	// chi keeps the full path when this router is mounted at /api, so the
	// prefix to strip includes it.
	r.Handle("/uploads/*", http.StripPrefix("/api/uploads/",
		func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Content-Type-Options", "nosniff")
				w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self'")
				next.ServeHTTP(w, r)
			})
		}(http.FileServer(http.Dir(uploadDir)))))

	r.Post("/upload", func(w http.ResponseWriter, r *http.Request) {
		// Cap the whole request, not just what is buffered in memory.
		// ParseMultipartForm alone spills the remainder to disk, so a large
		// upload could fill the volume.
		const maxUpload = 8 << 20 // 8 MiB
		r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
		if err := r.ParseMultipartForm(maxUpload); err != nil {
			http.Error(w, "That file is too large. The limit is 8 MB.", http.StatusRequestEntityTooLarge)
			return
		}

		file, handler, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "error retrieving file", http.StatusBadRequest)
			return
		}
		defer file.Close()

		// Only images. These files are served back from this origin, so
		// accepting arbitrary types would let an uploaded .html or .svg run
		// script against the API's own origin.
		head := make([]byte, 512)
		n, _ := file.Read(head)
		contentType := http.DetectContentType(head[:n])
		if !strings.HasPrefix(contentType, "image/") {
			http.Error(w, "Only image files can be uploaded.", http.StatusUnsupportedMediaType)
			return
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			http.Error(w, "Could not read that file.", http.StatusInternalServerError)
			return
		}

		filename := fmt.Sprintf("%d_%s", time.Now().UnixNano(), safeUploadName(handler.Filename))
		dst, err := os.Create(filepath.Join(uploadDir, filename))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer dst.Close()

		if _, err := io.Copy(dst, file); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"url": "/uploads/" + filename})
	})

	r.Get("/stats", func(w http.ResponseWriter, r *http.Request) {
		contacts, err1 := db.GetAllContacts()
		leads, err2 := db.GetAllLeads()
		callbacks, err3 := db.GetAllCallbacks()
		messages, err4 := db.GetAllMessages()

		if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
			fmt.Printf("Error fetching stats: %v %v %v %v\n", err1, err2, err3, err4)
		}

		stats := map[string]int{
			"total_contacts":    len(contacts),
			"total_leads":       len(leads),
			"pending_callbacks": 0,
			"new_leads":         0,
			"total_messages":    len(messages),
		}

		for _, l := range leads {
			if l.Status == "new" {
				stats["new_leads"]++
			}
		}
		for _, c := range callbacks {
			if c.Status == "pending" {
				stats["pending_callbacks"]++
			}
		}

		json.NewEncoder(w).Encode(stats)
	})

	r.Get("/leads", func(w http.ResponseWriter, r *http.Request) {
		limit, offset, start, end := parseCommonParams(r)
		leads, err := db.GetLeadsPaginated(limit, offset, start, end)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		count, _ := db.GetTotalLeadsCount(start, end)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"data": leads, "total": count})
	})

	r.Post("/leads/update-status", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID     int    `json:"id"`
			Status string `json:"status"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		db.UpdateLeadStatus(body.ID, body.Status)
		w.WriteHeader(http.StatusOK)
	})

	r.Get("/callbacks", func(w http.ResponseWriter, r *http.Request) {
		callbacks, _ := db.GetAllCallbacks()
		json.NewEncoder(w).Encode(callbacks)
	})

	r.Post("/callbacks/mark-done", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID int `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		db.MarkCallbackDone(body.ID)
		w.WriteHeader(http.StatusOK)
	})

	r.Get("/contacts", func(w http.ResponseWriter, r *http.Request) {
		contacts, _ := db.GetAllContacts()
		json.NewEncoder(w).Encode(contacts)
	})

	r.Post("/contacts", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Phone string `json:"phone"`
			Name  string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := db.UpsertContact(body.Phone, body.Name); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	// Bulk import from the panel: [{phone, name}]. Numbers are normalised
	// the way WhatsApp writes them (country code, digits only) so an imported
	// contact and the same person messaging in are one row, not two.
	r.Post("/contacts/import", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Contacts []struct {
				Phone string `json:"phone"`
				Name  string `json:"name"`
			} `json:"contacts"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "That list could not be read.")
			return
		}
		if len(body.Contacts) > 10000 {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "Import at most 10,000 contacts at a time.")
			return
		}

		result := struct {
			Added   int      `json:"added"`
			Updated int      `json:"updated"`
			Invalid []string `json:"invalid"`
		}{Invalid: []string{}}
		for _, c := range body.Contacts {
			phone, ok := normalisePhone(c.Phone)
			if !ok {
				result.Invalid = append(result.Invalid, c.Phone)
				continue
			}
			inserted, err := db.ImportContact(phone, strings.TrimSpace(c.Name))
			if err != nil {
				writeJSONError(w, http.StatusInternalServerError, "The import stopped partway. Contacts before this point were saved.")
				return
			}
			if inserted {
				result.Added++
			} else {
				result.Updated++
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	})

	r.Delete("/contacts/{id}", func(w http.ResponseWriter, r *http.Request) {
		idStr := chi.URLParam(r, "id")
		var id int
		fmt.Sscanf(idStr, "%d", &id)
		if err := db.DeleteContact(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	r.Post("/contacts/subscribe-all", func(w http.ResponseWriter, r *http.Request) {
		updated, err := db.UpdateAllContactsOptOut(false)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			Updated int64 `json:"updated"`
		}{Updated: updated})
	})

	r.Post("/contacts/unsubscribe-all", func(w http.ResponseWriter, r *http.Request) {
		updated, err := db.UpdateAllContactsOptOut(true)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			Updated int64 `json:"updated"`
		}{Updated: updated})
	})

	r.Post("/contacts/{id}/opt-out", func(w http.ResponseWriter, r *http.Request) {
		idStr := chi.URLParam(r, "id")
		var id int
		fmt.Sscanf(idStr, "%d", &id)

		var body struct {
			OptOut bool `json:"opt_out"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if err := db.UpdateContactOptOut(id, body.OptOut); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	// Bounded. This used to call GetAllMessages, which has no LIMIT — the
	// handler returned every row ever written and ignored the limit the client
	// sent, so the payload grew without bound for the life of the deployment.
	r.Get("/messages", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))

		messages, total, err := db.GetMessagesPage(limit, offset)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "Could not read the message log.")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": messages, "total": total})
	})

	// Per-day and per-hour counts for the dashboard charts, aggregated in the
	// database rather than by shipping the log to the browser.
	r.Get("/messages/summary", func(w http.ResponseWriter, r *http.Request) {
		days, _ := strconv.Atoi(r.URL.Query().Get("days"))
		summary, err := db.GetMessageSummary(days)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "Could not read the conversation summary.")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(summary)
	})

	// ?after_id=N returns only what is newer, so the inbox poll does not refetch
	// the whole conversation every few seconds.
	r.Get("/messages/{phone}", func(w http.ResponseWriter, r *http.Request) {
		phone := chi.URLParam(r, "phone")
		afterID, _ := strconv.Atoi(r.URL.Query().Get("after_id"))

		messages, err := db.GetMessagesByPhoneAfter(phone, afterID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "Could not read that conversation.")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(messages)
	})

	r.Post("/send-message", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Phone   string `json:"phone"`
			Message string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
			strings.TrimSpace(body.Phone) == "" || strings.TrimSpace(body.Message) == "" {
			writeJSONError(w, http.StatusBadRequest, "A phone number and a message are both needed.")
			return
		}

		// Outside the 24-hour window Meta rejects a free-form message, and
		// sendTextMessage only logs that. Refusing here means the panel says
		// it was not sent instead of showing a reply the customer never got.
		inWindow, err := db.IsInServiceWindow(body.Phone)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "Could not check whether this contact can be messaged.")
			return
		}
		if !inWindow {
			writeJSONError(w, http.StatusConflict,
				"This contact has not messaged in the last 24 hours, so WhatsApp will not deliver a free reply. They need to message first.")
			return
		}

		sendTextMessage(body.Phone, body.Message)
		w.WriteHeader(http.StatusOK)
	})

	// ── Campaign Management ─────────────────────────────────────────────────

	r.Get("/campaigns", func(w http.ResponseWriter, r *http.Request) {
		limit, offset, start, end := parseCommonParams(r)
		campaigns, err := db.GetCampaignsPaginated(limit, offset, start, end)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		count, _ := db.GetTotalCampaignsCount(start, end)
		ids := make([]int, 0, len(campaigns))
		for _, c := range campaigns {
			ids = append(ids, c.ID)
		}
		// Without the counts the list still works; the report just shows
		// nothing for these rows.
		if delivery, err := db.GetDeliveryCounts(ids); err == nil {
			for i := range campaigns {
				if d, ok := delivery[campaigns[i].ID]; ok {
					campaigns[i].Delivery = &d
				}
			}
		} else {
			log.Printf("[Campaigns] could not read delivery counts: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"data": campaigns, "total": count})
	})

	r.Post("/campaigns", func(w http.ResponseWriter, r *http.Request) {
		var c db.Campaign
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		// Validation
		if c.Type != "quiz" && c.Type != "poster" {
			http.Error(w, "type must be 'quiz' or 'poster'", http.StatusBadRequest)
			return
		}
		if c.Type == "quiz" {
			if c.Question == "" || c.OptionA == "" || c.OptionB == "" || c.OptionC == "" || c.Explanation == "" {
				http.Error(w, "all quiz fields are required", http.StatusBadRequest)
				return
			}
			c.CorrectAnswer = strings.ToUpper(c.CorrectAnswer)
			if c.CorrectAnswer != "A" && c.CorrectAnswer != "B" && c.CorrectAnswer != "C" {
				http.Error(w, "correct_answer must be A, B, or C", http.StatusBadRequest)
				return
			}
			if len([]rune(c.Explanation)) > 300 {
				http.Error(w, "explanation must not exceed 300 characters", http.StatusBadRequest)
				return
			}
		}
		if c.Type == "poster" && c.ImageURL == "" {
			http.Error(w, "image_url is required for posters", http.StatusBadRequest)
			return
		}
		if c.Type == "poster" {
			if msg := validateCampaignButtons(c.Buttons); msg != "" {
				http.Error(w, msg, http.StatusBadRequest)
				return
			}
		} else {
			c.Buttons = nil // quiz buttons are always A, B and C
		}
		if c.ScheduledAt.IsZero() {
			http.Error(w, "scheduled_at is required", http.StatusBadRequest)
			return
		}
		c.TemplateName, c.TemplateLang = strings.TrimSpace(c.TemplateName), strings.TrimSpace(c.TemplateLang)
		c.RetryOf = 0 // only the retry route makes retries
		if c.MaxPaid < 0 {
			http.Error(w, "max_paid cannot be negative", http.StatusBadRequest)
			return
		}
		if c.Type != "poster" {
			c.TemplateName, c.TemplateLang = "", ""
		}
		// Check the template now: found missing at send time, the paid
		// half of the offer would quietly go to nobody.
		if c.TemplateName != "" {
			t, err := findTemplate(c.TemplateName, c.TemplateLang)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if problem := templateProblem(t); problem != "" {
				http.Error(w, fmt.Sprintf("template %q cannot be used: %s", t.Name, problem), http.StatusBadRequest)
				return
			}
		}

		id, err := db.CreateCampaign(c)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// "Send now" goes out straight away rather than at the next
		// one-minute tick. ClaimCampaign stops the tick sending it again.
		if !c.ScheduledAt.After(time.Now()) {
			go sendDueCampaigns()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]int{"id": id})
	})

	r.Get("/whatsapp-templates", templatesHandler)
	r.Post("/whatsapp-templates", createTemplateHandler)
	r.Delete("/whatsapp-templates/{name}", deleteTemplateHandler)
	r.Put("/whatsapp-templates/{name}/actions", templateActionsHandler)

	r.Delete("/campaigns/{id}", func(w http.ResponseWriter, r *http.Request) {
		idStr := chi.URLParam(r, "id")
		var id int
		fmt.Sscanf(idStr, "%d", &id)
		if err := db.CancelCampaign(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	// Who an offer reached and who it did not, and how many a retry would
	// try again: free inside the 24-hour window, as the template outside it.
	r.Get("/campaigns/{id}/recipients", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.Atoi(chi.URLParam(r, "id"))
		camp, err := db.GetCampaign(id)
		if err != nil {
			http.Error(w, "offer not found", http.StatusNotFound)
			return
		}
		list, err := db.GetRecipients(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		free, paid, err := retryPreview(camp)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		pending, _ := db.PendingRetry(id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"data":  list,
			"retry": map[string]interface{}{"free": len(free), "paid": len(paid), "pending": pending},
			"limit": messagingLimit(),
			"rate":  billing(false).Rate,
		})
	})

	// What WhatsApp has charged, the price of a paid message, and the
	// balance left as far as the panel can tell.
	r.Get("/billing", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(billing(r.URL.Query().Get("fresh") == "1"))
	})

	// Records the balance as read off WhatsApp Manager now.
	r.Post("/billing/balance", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Amount *float64 `json:"amount"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Amount == nil || *body.Amount < 0 {
			http.Error(w, "amount must be a number, 0 or more", http.StatusBadRequest)
			return
		}
		if err := setBalance(*body.Amount); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(billing(true))
	})

	// The paid-message limit, for the Broadcasts page and the composer.
	r.Get("/messaging-limit", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(messagingLimit())
	})

	// Every contact with the last offer they were sent, to follow who got
	// what and who has not had one yet.
	r.Get("/offer-contacts", func(w http.ResponseWriter, r *http.Request) {
		list, err := db.GetOfferContacts()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"data": list})
	})

	// Sends the offer again to the contacts it failed to reach, now.
	r.Post("/campaigns/{id}/retry", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.Atoi(chi.URLParam(r, "id"))
		camp, err := db.GetCampaign(id)
		if err != nil {
			http.Error(w, "offer not found", http.StatusNotFound)
			return
		}
		if camp.Type != "poster" || camp.Status != "sent" {
			http.Error(w, "only an offer that has been sent can be retried", http.StatusBadRequest)
			return
		}
		if pending, err := db.PendingRetry(id); err != nil || pending {
			http.Error(w, "a retry of this offer is already going out", http.StatusConflict)
			return
		}
		free, paid, err := retryPreview(camp)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if len(free)+len(paid) == 0 {
			http.Error(w, "nobody this offer missed can be reached again right now", http.StatusBadRequest)
			return
		}
		if camp.TemplateName != "" && len(paid) > 0 {
			t, err := findTemplate(camp.TemplateName, camp.TemplateLang)
			if err == nil {
				if problem := templateProblem(t); problem != "" {
					err = fmt.Errorf("template %q cannot be used: %s", t.Name, problem)
				}
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}

		retry := camp
		retry.ID = 0
		retry.RetryOf = camp.ID
		retry.MaxPaid = 0 // the daily limit still applies
		retry.ScheduledAt = time.Now()
		newID, err := db.CreateCampaign(retry)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		go sendDueCampaigns()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]int{"id": newID, "free": len(free), "paid": len(paid)})
	})

	r.Get("/campaigns/{id}/analytics", func(w http.ResponseWriter, r *http.Request) {
		idStr := chi.URLParam(r, "id")
		var id int
		fmt.Sscanf(idStr, "%d", &id)
		analytics, err := db.GetCampaignAnalytics(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(analytics)
	})

	// ── Offers (shown when a customer taps Offers) ───────────────────────────

	r.Get("/offers", func(w http.ResponseWriter, r *http.Request) {
		offers, err := db.ListOffers()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(offers)
	})

	saveOffer := func(w http.ResponseWriter, r *http.Request, id int) {
		var o db.Offer
		if err := json.NewDecoder(r.Body).Decode(&o); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		o.ID = id
		o.Title = strings.TrimSpace(o.Title)
		o.Description = strings.TrimSpace(o.Description)
		o.ImageURL = strings.TrimSpace(o.ImageURL)
		if msg := validateOffer(o); msg != "" {
			http.Error(w, msg, http.StatusBadRequest)
			return
		}
		if id == 0 {
			newID, err := db.CreateOffer(o)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			id = newID
		} else if err := db.UpdateOffer(o); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]int{"id": id})
	}

	r.Post("/offers", func(w http.ResponseWriter, r *http.Request) { saveOffer(w, r, 0) })

	r.Put("/offers/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(chi.URLParam(r, "id"))
		if err != nil || id <= 0 {
			http.Error(w, "invalid offer id", http.StatusBadRequest)
			return
		}
		saveOffer(w, r, id)
	})

	r.Delete("/offers/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(chi.URLParam(r, "id"))
		if err != nil || id <= 0 {
			http.Error(w, "invalid offer id", http.StatusBadRequest)
			return
		}
		if err := db.DeleteOffer(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	// ── BOT SETTINGS ─────────────────────────────────────────────────────────
	r.Get("/settings", func(w http.ResponseWriter, r *http.Request) {
		settings, err := db.GetAllSettings()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(settings)
	})

	r.Post("/settings", func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]string
		json.NewDecoder(r.Body).Decode(&payload)
		for k, v := range payload {
			db.UpdateSetting(k, v)
		}
		w.WriteHeader(http.StatusOK)
	})

	// ── FAQ / KNOWLEDGE BASE ──────────────────────────────────────────────
	r.Get("/faqs", func(w http.ResponseWriter, r *http.Request) {
		faqs, err := db.GetAllFAQs()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(faqs)
	})

	r.Post("/faqs", func(w http.ResponseWriter, r *http.Request) {
		var f db.FAQ
		if err := json.NewDecoder(r.Body).Decode(&f); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := db.SaveFAQ(f); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	r.Delete("/faqs/{id}", func(w http.ResponseWriter, r *http.Request) {
		idStr := chi.URLParam(r, "id")
		var id int
		fmt.Sscanf(idStr, "%d", &id)
		if err := db.DeleteFAQ(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	return r
}

func parseCommonParams(r *http.Request) (limit, offset int, start, end string) {
	fmt.Sscanf(r.URL.Query().Get("limit"), "%d", &limit)
	fmt.Sscanf(r.URL.Query().Get("offset"), "%d", &offset)
	if limit <= 0 {
		limit = 10
	}
	start = r.URL.Query().Get("start_date")
	end = r.URL.Query().Get("end_date")
	return
}

// normalisePhone returns a number the way WhatsApp writes it: country code
// and digits, no plus or spaces. A bare 10-digit number, or one with a
// leading 0, is taken to be Indian.
func normalisePhone(raw string) (string, bool) {
	var b strings.Builder
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	d := b.String()
	switch {
	case len(d) == 10:
		d = "91" + d
	case len(d) == 11 && strings.HasPrefix(d, "0"):
		d = "91" + d[1:]
	}
	if len(d) < 11 || len(d) > 15 {
		return "", false
	}
	return d, true
}

// safeUploadName keeps only letters, digits, dots, dashes and underscores.
// Replacing just the ASCII space was not enough: macOS screenshot names put a
// narrow no-break space before "AM"/"PM", which survived into the saved name,
// and Meta then fetched the image with a plain space and got a 404.
func safeUploadName(name string) string {
	name = filepath.Base(name)
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	if s := strings.Trim(b.String(), "."); s != "" {
		return s
	}
	return "upload"
}

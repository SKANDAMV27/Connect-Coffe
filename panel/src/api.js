import axios from 'axios';

/**
 * Set VITE_API_URL (no trailing /api — the client appends it). The fallback is
 * the local Go server, not a deployed host: a hardcoded production URL here is
 * how the panel ended up silently pointing at a Railway app that no longer
 * exists, with no error anywhere to say so.
 */
const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

export const TOKEN_KEY = 'connect_token';
export const EMAIL_KEY = 'connect_email';

const api = axios.create({
  baseURL: `${BASE_URL}/api`,
});

/**
 * Every /api route behind AuthMiddleware requires `Authorization: Bearer
 * <session token>`; without this header the server answers 401 and the panel
 * renders empty tables with no explanation. The token is issued by
 * POST /api/login, is signed and time-limited, and is held in localStorage.
 */
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (config.baseURL && config.baseURL.includes('ngrok')) {
    config.headers['ngrok-skip-browser-warning'] = 'true';
  }
  return config;
});

/**
 * An expired or missing token has to send the operator back to sign in rather
 * than leaving them on a page that silently shows nothing.
 */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && !window.location.pathname.startsWith('/login')) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(EMAIL_KEY);
      window.location.assign('/login');
    }
    return Promise.reject(error);
  },
);

/**
 * Sign in with an email address and a password.
 *
 * The server returns a signed session token that expires, not the shared API
 * secret it used to hand back — so a token is now per-account and does not
 * live for ever. The address is kept alongside it only so the shell can show
 * who is signed in.
 */
export const login = async (email, password) => {
  const { data } = await api.post('/login', { email, password });
  if (!data?.token) throw new Error('The server did not return a session token.');
  localStorage.setItem(TOKEN_KEY, data.token);
  if (data.email) localStorage.setItem(EMAIL_KEY, data.email);
  return data.token;
};

export const getSignedInEmail = () => localStorage.getItem(EMAIL_KEY) || '';

export const logout = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
};

export const getStats = () => api.get('/stats');
export const getLeads = (params) => api.get('/leads', { params });
export const updateLeadStatus = (id, status) => api.post('/leads/update-status', { id, status });
export const getCallbacks = () => api.get('/callbacks');
export const markCallbackDone = (id) => api.post('/callbacks/mark-done', { id });
export const getContacts = () => api.get('/contacts');
export const saveContact = (data) => api.post('/contacts', data);
export const deleteContact = (id) => api.delete(`/contacts/${id}`);
export const importContacts = (contacts) => api.post('/contacts/import', { contacts });
export const toggleOptOut = (id, optOut) => api.post(`/contacts/${id}/opt-out`, { opt_out: optOut });
export const subscribeAllContacts = () => api.post('/contacts/subscribe-all');
export const unsubscribeAllContacts = () => api.post('/contacts/unsubscribe-all');
export const getMessages = (params) => api.get('/messages', { params });

/** Per-day and per-hour counts for the dashboard, aggregated server-side. */
export const getMessageSummary = (days = 14) =>
  api.get('/messages/summary', { params: { days } });
/** Pass afterId to fetch only what is newer than the last message you hold. */
export const getChatHistory = (phone, afterId = 0) =>
  api.get(`/messages/${phone}`, { params: afterId ? { after_id: afterId } : undefined });
export const sendMessage = (phone, message) => api.post('/send-message', { phone, message });

// Campaign Management
export const getCampaigns = (params) => api.get('/campaigns', { params });
export const createCampaign = (data) => api.post('/campaigns', data);
export const deleteCampaign = (id) => api.delete(`/campaigns/${id}`);
export const getCampaignAnalytics = (id) => api.get(`/campaigns/${id}/analytics`);
export const getCampaignRecipients = (id) => api.get(`/campaigns/${id}/recipients`);
export const retryCampaign = (id) => api.post(`/campaigns/${id}/retry`);
export const getMessagingLimit = () => api.get('/messaging-limit');
export const getOfferContacts = () => api.get('/offer-contacts');
export const getBilling = (fresh = false) => api.get('/billing', { params: fresh ? { fresh: 1 } : {} });
export const setMetaBalance = (amount) => api.post('/billing/balance', { amount });
// Approved marketing templates on the WhatsApp account, for reaching
// contacts outside the free 24-hour window.
export const getWhatsAppTemplates = () => api.get('/whatsapp-templates');
// Sends a new marketing template to Meta for review.
export const createWhatsAppTemplate = (data) => api.post('/whatsapp-templates', data);
export const deleteWhatsAppTemplate = (name) => api.delete(`/whatsapp-templates/${encodeURIComponent(name)}`);
// What each of a template's quick-reply buttons does, in button order.
export const setWhatsAppTemplateActions = (name, actions) =>
  api.put(`/whatsapp-templates/${encodeURIComponent(name)}/actions`, { actions });

// Offers — what a customer sees on tapping Offers in the bot
export const getOffers = () => api.get('/offers');
export const createOffer = (data) => api.post('/offers', data);
export const updateOffer = (id, data) => api.put(`/offers/${id}`, data);
export const deleteOffer = (id) => api.delete(`/offers/${id}`);

// Employee Management
export const getEmployees = (params) => api.get('/employees', { params });
export const addEmployee = (data) => api.post('/employees', data);
export const deleteEmployee = (id) => api.delete(`/employees/${id}`);
export const getAttendance = (params) => api.get('/attendance', { params });
export const getLeaveRequests = (params) => api.get('/leave-requests', { params });
export const updateLeaveStatus = (id, status) => api.post('/leave-requests/update-status', { id, status });
export const createReminder = (data) => api.post('/reminders', data);
export const getRemindersHistory = (params) => api.get('/reminders/history', { params });
export const sendAnnouncement = (data) => api.post('/announcements', data);

export const uploadImage = (file) => {
  const formData = new FormData();
  formData.append('file', file);
  return api.post('/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
};

export const getSettings = () => api.get('/settings');
export const updateSettings = (data) => api.post('/settings', data);

export const getFaqs = () => api.get('/faqs');
export const saveFaq = (data) => api.post('/faqs', data);
export const deleteFaq = (id) => api.delete(`/faqs/${id}`);

export default api;

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../components/Modal';
import { getContacts, getChatHistory, sendMessage, saveContact } from '../api';
import { useSearchParams } from 'react-router-dom';
import { Send, Search, MessageSquare, ArrowLeft, Edit2, Check, X } from 'lucide-react';
import { format } from 'date-fns';
import { formatSlug } from '../utils';
import { describeWindow, isInWindow, latest } from '../lib/replyWindow';

// Inbound messages already arrive by webhook and are written straight to the
// log, so the poll only decides how quickly the open tab notices. Three
// seconds was a full conversation refetch twenty times a minute; five seconds
// of an incremental fetch is a fraction of the load and reads the same.
const HISTORY_POLL_MS = 5000;
const CONTACTS_POLL_MS = 15000;
// Re-reads the reply window so "free to reply for 5m" counts down and the
// send box locks when it runs out, without waiting for a poll.
const WINDOW_TICK_MS = 30000;

const Messages = () => {
const [searchParams] = useSearchParams();
const [contacts, setContacts] = useState([]);
const [selectedContact, setSelectedContact] = useState(null);
const [messages, setMessages] = useState([]);
const [newMessage, setNewMessage] = useState('');
const [searchTerm, setSearchTerm] = useState('');
const [loadingHistory, setLoadingHistory] = useState(false);
  const [modal, setModal] = useState({ open: false, title: '', message: '', type: 'success' });
const [userHasScrolledUp, setUserHasScrolledUp] = useState(false);
const [isEditingName, setIsEditingName] = useState(false);
const [editedName, setEditedName] = useState('');
const [now, setNow] = useState(() => Date.now());
const scrollRef = useRef(null);
// The id of the newest message held, and the conversation it belongs to.
// Refs rather than state: the poll reads them without needing to be
// recreated, so the interval is not torn down on every new message.
const lastIdRef = useRef(0);
const phoneRef = useRef(null);

const fetchContacts = useCallback(async () => {
try {
const resp = await getContacts();
setContacts(resp.data || []);
} catch (err) {
console.error(err);
}
}, []);
// A background poll asks only for what is newer than the last message on
// screen and appends it. It used to refetch the entire conversation every
// three seconds, which was a full scan of messages_log per poll per open tab,
// and replaced the whole array each time — so React re-rendered every bubble
// even when nothing had changed.
const fetchHistory = useCallback(async (phone, background = false) => {
  if (!background) setLoadingHistory(true);

  try {
    const afterId = background ? lastIdRef.current : 0;
    const resp = await getChatHistory(phone, afterId);
    const incoming = resp.data || [];

    if (!background) {
      setMessages(incoming);
    } else if (incoming.length > 0) {
      // Guard against a late reply from a conversation you have since left.
      if (phoneRef.current !== phone) return;
      setMessages((current) => {
        const seen = new Set(current.map((m) => m.id));
        const added = incoming.filter((m) => !seen.has(m.id));
        return added.length > 0 ? [...current, ...added] : current;
      });
    }

    const newest = incoming[incoming.length - 1];
    if (newest?.id) lastIdRef.current = Math.max(lastIdRef.current, newest.id);
  } catch (err) {
    console.error(err);
  } finally {
    if (!background) setLoadingHistory(false);
  }
}, []);

useEffect(() => {
fetchContacts();
const interval = setInterval(fetchContacts, CONTACTS_POLL_MS);
return () => clearInterval(interval);
}, [fetchContacts]);

useEffect(() => {
const interval = setInterval(() => setNow(Date.now()), WINDOW_TICK_MS);
return () => clearInterval(interval);
}, []);

// The open conversation's reply window. selectedContact is the snapshot taken
// when it was clicked, so the fresh copy from the contacts poll is preferred,
// and a message that has just arrived in this chat counts at once rather than
// on the next poll.
const replyWindow = useMemo(() => {
if (!selectedContact) return null;
const live = contacts.find((c) => c.id === selectedContact.id) || selectedContact;
const lastInChat = [...messages].reverse().find((m) => m.direction === 'incoming');
return describeWindow(latest(live.last_incoming_at, lastInChat?.sent_at), now);
}, [selectedContact, contacts, messages, now]);
const canReply = !!replyWindow?.open;

useEffect(() => {
if (contacts.length > 0 && !selectedContact) {
const phone = searchParams.get('phone');

  if (phone) {
    const contact = contacts.find(c => c.phone === phone);

    if (contact) setSelectedContact(contact);
  }
}

}, [contacts, searchParams, selectedContact]);

useEffect(() => {
if (selectedContact) {
setUserHasScrolledUp(false);
lastIdRef.current = 0;
phoneRef.current = selectedContact.phone;
fetchHistory(selectedContact.phone);

  const interval = setInterval(
    () => fetchHistory(selectedContact.phone, true),
    HISTORY_POLL_MS
  );

  return () => clearInterval(interval);
}

phoneRef.current = null;
return undefined;
}, [selectedContact, fetchHistory]);

useEffect(() => {
if (messages.length > 0 && !userHasScrolledUp) {
scrollToBottom();
}
}, [messages, userHasScrolledUp]);

const scrollToBottom = () => {
if (scrollRef.current) {
scrollRef.current.scrollTop =
scrollRef.current.scrollHeight;
}
};

const handleScroll = (e) => {
const {
scrollTop,
scrollHeight,
clientHeight
} = e.currentTarget;

const isAtBottom =
  scrollHeight - scrollTop <= clientHeight + 50;

if (!isAtBottom) {
  setUserHasScrolledUp(true);
} else {
  setUserHasScrolledUp(false);
}

};



const handleSend = async (e) => {
if (e) e.preventDefault();

if (!newMessage.trim() || !selectedContact || !canReply) return;

try {
  await sendMessage(
    selectedContact.phone,
    newMessage
  );

  const sentMsg = {
    direction: 'sent',
    content: newMessage,
    created_at: new Date().toISOString()
  };

  setMessages(prev => [
    ...prev,
    sentMsg
  ]);

  setNewMessage('');
  setUserHasScrolledUp(false);

  setTimeout(scrollToBottom, 50);
} catch (err) {
  console.error(err);
  setModal({
    open: true,
    title: 'Message not sent',
    // The server says why — most often that the 24-hour window has closed.
    message:
      err.response?.data?.error ||
      'The message could not be sent. Check your connection and try again.',
    type: 'error',
  });
}

};

const handleSaveName = async () => {
if (!selectedContact || !editedName.trim()) return;

try {
  await saveContact({
    phone: selectedContact.phone,
    name: editedName
  });

  setIsEditingName(false);

  fetchContacts();

  setSelectedContact(prev => ({
    ...prev,
    name: editedName
  }));
} catch (err) {
  console.error(err);
  setModal({
    open: true,
    title: 'Could not save the name',
    message: 'Nothing was changed. Please try again.',
    type: 'error',
  });
}

};

// People who wrote in come first, latest reply on top. Sorting on the last
// message either way put everyone a broadcast went to above the replies.
const lastReply = (c) => (c.last_incoming_at ? new Date(c.last_incoming_at).getTime() : 0);
const filteredContacts = contacts
.filter(c =>
(c.name || '')
.toLowerCase()
.includes(searchTerm.toLowerCase()) ||
c.phone.includes(searchTerm)
)
.sort((a, b) => lastReply(b) - lastReply(a));

return ( <div className="flex h-full overflow-hidden rounded-xl border border-border bg-white shadow-card">
<Modal
  isOpen={modal.open}
  onClose={() => setModal({ ...modal, open: false })}
  title={modal.title}
  message={modal.message}
  type={modal.type}
/>

  {/* Search / Contact List Sidebar */}

  <div
    className={`
      w-full
      lg:w-80
      bg-white
      border-r
      border-border
      flex
      flex-col
      shrink-0
      ${
        selectedContact
          ? 'hidden lg:flex'
          : 'flex'
      }
    `}
  >

    {/* Sidebar Header */}

    <div className="p-6 border-b border-border">

      <div className="px-3 py-1 bg-primary-light rounded-full inline-block mb-4">

        <span className="text-[10px] font-medium uppercase tracking-widest text-primary">
          Messages
        </span>

      </div>


      {/* Search */}

      <div className="relative">

        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />

        <input
          type="text"
          placeholder="Search..."
          className="
            w-full
            bg-white
            border
            border-border
            pl-11
            pr-4
            py-3
            rounded-lg
            text-xs
            font-medium
            text-text-primary
            outline-none
            focus:border-primary
            transition-colors
          "
          value={searchTerm}
          onChange={(e) =>
            setSearchTerm(e.target.value)
          }
        />

      </div>

    </div>


    {/* Contact List */}

    <div className="flex-1 overflow-y-auto divide-y divide-border">

      {filteredContacts.map((contact) => (

        <div
          key={contact.id}
          onClick={() =>
            setSelectedContact(contact)
          }
          className={`
            p-5
            cursor-pointer
            transition-colors
            flex
            items-center
            gap-4
            ${
              selectedContact?.id === contact.id
                ? 'bg-primary-light border-r-2 border-primary'
                : 'hover:bg-background'
            }
          `}
        >

          {/* Avatar */}

          <div
            className={`
              relative
              w-10
              h-10
              rounded-lg
              flex
              items-center
              justify-center
              font-semibold
              text-xs
              shrink-0
              ${
                selectedContact?.id === contact.id
                  ? 'bg-primary text-white'
                  : 'bg-background text-text-secondary'
              }
            `}
          >

            {(contact.name || 'A')[0].toUpperCase()}

            <span
              aria-hidden="true"
              className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-white ${
                isInWindow(contact.last_incoming_at, now) ? 'bg-success' : 'bg-titanium-300'
              }`}
            />

          </div>


          {/* Contact Details */}

          <div className="flex-1 min-w-0">

            <h4
              className={`
                font-semibold
                text-xs
                truncate
                capitalize
                ${
                  selectedContact?.id === contact.id
                    ? 'text-text-primary'
                    : 'text-text-primary'
                }
              `}
            >

              {contact.name
                ? formatSlug(contact.name)
                : contact.phone}

            </h4>


            <p className="text-[10px] truncate font-medium text-text-secondary mt-1">

              {contact.phone}

              <span className="sr-only">
                {isInWindow(contact.last_incoming_at, now)
                  ? ' — can reply free'
                  : ' — needs to message first'}
              </span>

            </p>

          </div>

        </div>

      ))}

    </div>

  </div>


  {/* Main Chat Area */}

  <div
    className={`
      flex-1
      min-w-0
      flex
      flex-col
      bg-background
      relative
      ${
        selectedContact
          ? 'flex'
          : 'hidden lg:flex'
      }
    `}
  >

    {selectedContact ? (

      <>

        {/* Chat Header */}

        <div className="h-20 px-6 lg:px-10 bg-white border-b border-border flex items-center justify-between shrink-0 sticky top-0 z-20">

          <div className="flex items-center gap-4">

            {/* Mobile Back */}

            <button
              onClick={() =>
                setSelectedContact(null)
              }
              className="
                lg:hidden
                p-2
                hover:bg-background
                rounded-lg
                mr-2
                transition-colors
              "
            >

              <ArrowLeft className="w-5 h-5 text-text-secondary" />

            </button>


            {/* Avatar */}

            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center text-white font-semibold text-xs">

              {(selectedContact.name || 'A')[0].toUpperCase()}

            </div>


            <div>

              <div className="flex items-center gap-2 mb-1">

                {isEditingName ? (

                  <div className="flex items-center gap-2">

                    <input
                      type="text"
                      className="
                        bg-background
                        border
                        border-border
                        px-3
                        py-1.5
                        rounded-lg
                        text-xs
                        font-medium
                        text-text-primary
                        outline-none
                        focus:border-primary
                        transition-colors
                      "
                      value={editedName}
                      onChange={(e) =>
                        setEditedName(e.target.value)
                      }
                      autoFocus
                      onKeyDown={(e) =>
                        e.key === 'Enter' &&
                        handleSaveName()
                      }
                    />


                    <button
                      onClick={handleSaveName}
                      className="
                        p-1.5
                        hover:bg-success-light
                        text-success
                        rounded-lg
                        transition-colors
                      "
                    >

                      <Check className="w-3 h-3" />

                    </button>


                    <button
                      onClick={() =>
                        setIsEditingName(false)
                      }
                      className="
                        p-1.5
                        hover:bg-red-50
                        text-red-500
                        rounded-lg
                        transition-colors
                      "
                    >

                      <X className="w-3 h-3" />

                    </button>

                  </div>

                ) : (

                  <>

                    <h3 className="font-semibold text-text-primary text-sm tracking-tight capitalize leading-none">

                      {selectedContact.name
                        ? formatSlug(
                            selectedContact.name
                          )
                        : selectedContact.phone}

                    </h3>


                    <button
                      onClick={() => {
                        setIsEditingName(true);
                        setEditedName(
                          selectedContact.name || ''
                        );
                      }}
                      className="
                        p-1.5
                        hover:bg-background
                        text-text-secondary
                        hover:text-primary
                        transition-colors
                        rounded-lg
                      "
                    >

                      <Edit2 className="w-3 h-3" />

                    </button>

                  </>

                )}

              </div>


              <div className="flex items-center gap-1.5">

                <div
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full ${canReply ? 'bg-success' : 'bg-titanium-300'}`}
                />

                <span
                  className={`text-[11px] font-medium ${canReply ? 'text-success' : 'text-text-secondary'}`}
                >

                  {replyWindow?.label}

                </span>

              </div>

            </div>

          </div>

        </div>


        {/* Messages */}

        <div
          className="flex-1 overflow-y-auto overflow-x-hidden p-6 lg:p-10 space-y-4"
          ref={scrollRef}
          onScroll={handleScroll}
        >

          {loadingHistory && (
            <div className="flex items-center justify-center gap-3 py-10">
              <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" />
              <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-titanium-700">
                Loading conversation
              </span>
            </div>
          )}

          {!loadingHistory && messages.map((msg, idx) => {

            const content =
              msg.content ||
              msg.message ||
              '';

            const imageRegex =
              /^\[[Ii]mage:\s*(https?:\/\/[^\]]+)\]\s*([\s\S]*)$/;

            const match =
              content.match(imageRegex);

            const imageUrl =
              match
                ? match[1]
                : null;

            const textContent =
              match
                ? match[2]
                : content;


            return (

              <div
                key={msg.id || idx}
                className={`
                  flex
                  ${
                    msg.direction === 'sent' ||
                    msg.direction === 'outgoing'
                      ? 'justify-end'
                      : 'justify-start'
                  }
                `}
              >

                <div
                  className={`
                    max-w-[70%]
                    min-w-0
                    [overflow-wrap:anywhere]
                    text-[13px]
                    font-medium
                    p-1
                    rounded-lg
                    shadow-sm
                    relative
                    group
                    ${
                      msg.direction === 'sent' ||
                      msg.direction === 'outgoing'
                        ? 'bg-primary text-white'
                        : 'bg-white text-text-primary border border-border'
                    }
                  `}
                >

                  {imageUrl && (

                    <div className="mb-1 overflow-hidden rounded-lg bg-background">

                      <img
                        src={imageUrl}
                        alt="Visual"
                        className="w-full h-auto object-cover max-h-80 hover:scale-105 transition-transform duration-700"
                      />

                    </div>

                  )}


                  <div
                    className={`
                      px-5
                      py-3
                      ${
                        imageUrl
                          ? 'pt-1'
                          : ''
                      }
                    `}
                  >

                    {textContent.includes('_') &&
                    textContent.length < 30 ? (

                      <div className="flex items-center gap-2 py-1.5 px-3 bg-primary-light rounded-lg border border-primary/10 mb-2">

                        <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />

                        <span className="text-[10px] font-medium uppercase tracking-widest text-primary">

                          User Selection:{' '}
                          {formatSlug(textContent)}

                        </span>

                      </div>

                    ) : (

                      <p className="leading-relaxed whitespace-pre-line">

                        {textContent}

                      </p>

                    )}


                    <div
                      className={`
                        flex
                        items-center
                        gap-2
                        mt-2
                        transition-opacity
                        ${
                          msg.direction === 'sent' ||
                          msg.direction === 'outgoing'
                            ? 'opacity-60'
                            : 'opacity-40'
                        }
                      `}
                    >

                      <span className="text-[8px] font-medium uppercase tracking-widest">

                        {msg.created_at ||
                        msg.sent_at
                          ? format(
                              new Date(
                                msg.created_at ||
                                msg.sent_at
                              ),
                              'HH:mm'
                            )
                          : ''}

                      </span>


                      {(msg.direction === 'sent' ||
                        msg.direction === 'outgoing') && (

                        <svg
                          className="w-2.5 h-2.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                        >

                          <path
                            d="M20 6L9 17L4 12"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />

                        </svg>

                      )}

                    </div>

                  </div>

                </div>

              </div>

            );

          })}

        </div>


        {/* Message Input */}

        <div className="p-6 lg:p-8 bg-white border-t border-border">

          <div className="max-w-4xl mx-auto flex items-center gap-3 bg-background p-2 rounded-lg border border-border">

            <input
              type="text"
              disabled={!canReply}
              aria-label="Reply"
              placeholder={
                canReply
                  ? 'Type a message...'
                  : 'They need to message first'
              }
              className="
                flex-1
                bg-transparent
                border-none
                outline-none
                px-5
                py-3
                text-xs
                font-medium
                text-text-primary
                placeholder:text-text-secondary
                disabled:cursor-not-allowed
              "
              value={newMessage}
              onChange={(e) =>
                setNewMessage(e.target.value)
              }
              onKeyPress={(e) =>
                e.key === 'Enter' &&
                handleSend()
              }
            />


            <button
              onClick={handleSend}
              disabled={!newMessage.trim() || !canReply}
              aria-label="Send"
              className="
                w-11
                h-11
                bg-primary
                text-white
                rounded-lg
                flex
                items-center
                justify-center
                hover:bg-primary-hover
                transition-colors
                active:scale-95
                disabled:opacity-40
                disabled:cursor-not-allowed
              "
            >

              <Send className="w-4 h-4" />

            </button>

          </div>

        </div>

      </>

    ) : (

      /* No Chat Selected */

      <div className="flex-1 flex flex-col items-center justify-center text-center p-20">

        <div className="w-16 h-16 bg-primary-light rounded-lg flex items-center justify-center mb-6">

          <MessageSquare className="w-7 h-7 text-primary" />

        </div>


        <h2 className="text-2xl font-semibold text-text-primary tracking-tight">

          No Chat Selected

        </h2>


        <p className="text-[10px] font-medium uppercase tracking-widest text-text-secondary mt-3">

          Pick a contact to start chatting

        </p>

      </div>

    )}

  </div>

</div>

);
};

export default Messages;

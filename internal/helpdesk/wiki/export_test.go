package wiki

// PurgeTrash empties the trash of pages trashed before a time, as the hourly job does.
var PurgeTrash = purgeTrash

// SendReminders sends the reminders due at a time, as the job every minute does.
var SendReminders = sendReminders

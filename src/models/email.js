const mongoose = require('mongoose')

const emailSchema = mongoose.Schema({
	_id: String,
	userUid: {
		type: String,
		trim: true,
		required: false
	},
	userName: {
		type: String,
		trim: true,
		required: false
	},
	password: {
		type: String,
		required: false,
		select : false
	},
	userEmail: {
		type: String,
		required: false
	},
	userPhoneNumber: {
		type: Number,
		required: false
	}
}, {
	versionKey: false,
	timestamps: true
})

// Deprecated
module.exports = mongoose.model('Email', emailSchema)
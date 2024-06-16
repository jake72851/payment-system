const mongoose = require('mongoose')

const couponuseSchema = mongoose.Schema({
	coupon: {
		type: String,
		required: true,
		ref: 'Coupon'
	},
	userId: {
		type: String,
		required: true,
		ref: 'User'
	}
}, {
	versionKey: false,
	timestamps: true
})

module.exports = mongoose.model('Coupon_use', couponuseSchema)

module.exports.exist = (userId, couponId) => {
	return new Promise((resolve, reject) => {
		try {
			module.exports.findOne({userId: userId, coupon: couponId})
				.then(data => {
					console.log({userId: userId, coupon: couponId})
					console.log(data)
					return resolve(!!data)
				})
		} catch (e) {
			console.error(e)
			return reject(e)
		}
	})
}
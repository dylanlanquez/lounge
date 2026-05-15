import type { BookingStateApi } from '../state.ts';
import { BookingReview } from '../BookingReview.tsx';
import { PaymentChoiceCard } from '../PaymentChoiceCard.tsx';
import { QUIZ } from '../quizTokens.ts';
import type { WidgetCopy } from '../copy.ts';

// Review step — sits between Details (form) and Payment (Stripe).
// Renders the booking summary card and the payment-option selector
// on a single screen the customer reviews + commits on.
//
// Previously Details hosted both. That layout put the payment
// chooser below-the-fold on phones and the customer thought the
// form was broken because the footer "Next" wouldn't enable —
// they hadn't scrolled to see the selector. Splitting the surfaces
// puts the choice right under the summary on its own focused
// screen so the customer never misses it.
//
// The footer's Next routes from here:
//   • pay_full / pay_deposit  → advance to the Payment (Stripe) step
//   • pay_on_the_day          → submit immediately, no PI
//   • free service            → submit immediately, no PI
//
// PaymentChoiceCard pre-selects a default option on mount so the
// commit button is enabled the moment the customer lands.

export function ReviewStep({
  api,
  copy,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  accent?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        maxWidth: 720,
        margin: '0 auto',
        width: '100%',
        // Matches DetailsStep's marginTop:32 so the two screens read
        // as siblings in the same flow.
        marginTop: 32,
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
      }}
    >
      <BookingReview api={api} copy={copy} accent={accent} />
      <PaymentChoiceCard api={api} accent={accent} />
    </div>
  );
}

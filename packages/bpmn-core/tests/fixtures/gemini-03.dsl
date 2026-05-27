Employee:
//Includes near misses, risks, and defects
(start Incident Occurred)
Inform Employer
Employer: Assess Incident
...

...
Employer: Assess Incident
Is it a fatality or serious injury?
No
Employer: Assess absence duration
...

...
Employer: Assess Incident
Is it a fatality or serious injury?
Yes
Employer: Check emergency report status
...

...
Employer: Check emergency report status
Was it reported to emergency services?
Yes
Employer: Assess absence duration
...

...
Employer: Check emergency report status
Was it reported to emergency services?
No
Report to Labour Inspectorate
Employer: Assess absence duration
...

...
Employer: Assess absence duration
Does it cause over 3 days absence?
No
(finish)

...
Employer: Assess absence duration
Does it cause over 3 days absence?
Yes
//Must be reported within 5 days
Report employee accident to insurance provider
(finish)

Self-Employed:
//Ensure timely reporting of own and employee accidents
(start Self-Employed Accident)
Report accident to insurance provider
(finish)

Student:
//Applies to school, kindergarten, and university students
(start Student Accident Occurred)
Inform Directorate
Directorate: Assess Student Accident
Is there physical injury or fatality?
No
(finish)

Student:
//Applies to school, kindergarten, and university students
(start Student Accident Occurred)
Inform Directorate
Directorate: Assess Student Accident
Is there physical injury or fatality?
Yes
//In triplicate within 5 days
Report student accident to insurance provider
(finish)

Insured Party:
//Applies to private insurance
(start Private Accident)
Report accident in writing
Is there a fatality?
No
(finish)

Insured Party:
//Applies to private insurance
(start Private Accident)
Report accident in writing
Is there a fatality?
Yes
//Within 3 days
Report fatal accident
(finish)